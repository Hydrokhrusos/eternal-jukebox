const PORT = Number(Deno.env.get("EJB_HELPER_PORT") ?? 43173);
const LOCAL_APP_DATA = Deno.env.get("LOCALAPPDATA") ?? ".";
const CACHE_DIR = Deno.env.get("EJB_AUDIO_CACHE")
    ?? `${LOCAL_APP_DATA}\\SpicetifyEternalJukeboxAudioCache`;
const WINGET_PACKAGES = `${LOCAL_APP_DATA}\\Microsoft\\WinGet\\Packages`;

type ResolveResult = {
    ok: boolean;
    url?: string;
    file?: string;
    query?: string;
    matchedTitle?: string;
    matchedUploader?: string;
    matchedDuration?: number;
    confidence?: number;
    officialAudio?: boolean;
    error?: string;
};

type ResolveRequest = {
    query: string;
    trackKey: string;
    title: string;
    artist: string;
    durationMs: number;
};

type YouTubeCandidate = {
    id?: string;
    title?: string;
    fulltitle?: string;
    alt_title?: string;
    webpage_url?: string;
    original_url?: string;
    url?: string;
    duration?: number | string;
    uploader?: string;
    channel?: string;
    artist?: string;
    creator?: string;
    description?: string;
    entries?: YouTubeCandidate[];
};

type ScoredCandidate = {
    candidate: YouTubeCandidate;
    url: string;
    ok: boolean;
    score: number;
    titleScore: number;
    artistScore: number;
    durationScore: number;
    officialAudio: boolean;
    reasons: string[];
};

const SEARCH_RESULT_COUNT = 6;
const TOPIC_SEARCH_RESULT_COUNT = 5;
const OFFICIAL_AUDIO_BONUS = 0.08;
const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "feat",
    "featuring",
    "ft",
    "hd",
    "hq",
    "lyric",
    "lyrics",
    "music",
    "of",
    "official",
    "or",
    "provided",
    "recordings",
    "records",
    "remaster",
    "remastered",
    "score",
    "soundtrack",
    "the",
    "topic",
    "vevo",
    "video",
    "visualiser",
    "visualizer",
    "youtube",
]);
const VERSION_PHRASES = [
    "8d",
    "acapella",
    "acoustic",
    "cover",
    "instrumental",
    "karaoke",
    "live",
    "nightcore",
    "remix",
    "slowed",
    "sped up",
];

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers": "*",
            "content-type": "application/json",
        },
    });
}

function audioResponse(data: Uint8Array, contentType: string): Response {
    return new Response(data.slice().buffer, {
        headers: {
            "access-control-allow-origin": "*",
            "accept-ranges": "bytes",
            "cache-control": "public, max-age=86400",
            "content-type": contentType,
        },
    });
}

function sanitize(value: string): string {
    return value
        .replace(/[^a-z0-9._-]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 90) || "track";
}

async function exists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path);
        return true;
    } catch {
        return false;
    }
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeText(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[()[\]{}]/g, " ")
        .replace(/\b(feat|ft|featuring)\.?\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokens(value: string): string[] {
    return normalizeText(value)
        .split(" ")
        .filter((token) => token && !STOP_WORDS.has(token));
}

function tokenCoverage(expected: string[], actual: string[]): number {
    if (!expected.length) {
        return 1;
    }

    const actualSet = new Set(actual);
    let matches = 0;

    for (const token of expected) {
        if (actualSet.has(token)) {
            matches += 1;
        }
    }

    return matches / expected.length;
}

function hasNormalizedPhrase(value: string, phrase: string): boolean {
    const normalizedValue = ` ${normalizeText(value)} `;
    const normalizedPhrase = ` ${normalizeText(phrase)} `;
    return normalizedValue.includes(normalizedPhrase);
}

function findVersionMismatch(expectedTitle: string, candidateTitle: string): string | null {
    for (const phrase of VERSION_PHRASES) {
        if (hasNormalizedPhrase(candidateTitle, phrase) && !hasNormalizedPhrase(expectedTitle, phrase)) {
            return phrase;
        }
    }

    return null;
}

function stripTitleContext(value: string): string {
    const stripped = value
        .replace(/\s*[-–—]\s*from\s+.+$/i, "")
        .replace(/\s*\/\s*(score|soundtrack|ost)\s*$/i, "")
        .trim();

    return stripped || value;
}

function titleFromRequest(request: ResolveRequest): string {
    return stripTitleContext(request.title || request.query.split(" - ")[0]?.trim() || request.query);
}

function artistFromRequest(request: ResolveRequest): string {
    if (request.artist) {
        return request.artist;
    }

    const parts = request.query.split(" - ");
    return parts.length > 1 ? parts.slice(1).join(" - ").trim() : "";
}

async function* walk(root: string): AsyncGenerator<string> {
    let entries: Deno.DirEntry[];

    try {
        entries = [];
        for await (const entry of Deno.readDir(root)) {
            entries.push(entry);
        }
    } catch {
        return;
    }

    for (const entry of entries) {
        const path = `${root}\\${entry.name}`;

        if (entry.isFile) {
            yield path;
        } else if (entry.isDirectory) {
            yield* walk(path);
        }
    }
}

async function findExecutable(name: string, envName: string): Promise<string> {
    const configured = Deno.env.get(envName);

    if (configured && await exists(configured)) {
        return configured;
    }

    const pathEntries = (Deno.env.get("PATH") ?? "").split(";").filter(Boolean);

    for (const entry of pathEntries) {
        const candidate = `${entry}\\${name}`;

        if (await exists(candidate)) {
            return candidate;
        }
    }

    for await (const candidate of walk(WINGET_PACKAGES)) {
        if (candidate.toLowerCase().endsWith(`\\${name.toLowerCase()}`)) {
            return candidate;
        }
    }

    throw new Error(`Could not find ${name}.`);
}

function contentTypeFor(path: string): string {
    const lower = path.toLowerCase();

    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".m4a")) return "audio/mp4";
    if (lower.endsWith(".opus")) return "audio/ogg";
    if (lower.endsWith(".ogg")) return "audio/ogg";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".webm")) return "audio/webm";
    return "application/octet-stream";
}

async function commandOutput(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = new Deno.Command(command, {
        args,
        stdout: "piped",
        stderr: "piped",
    });
    const output = await child.output();
    const decoder = new TextDecoder();

    return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
    };
}

async function newestMatchingFile(prefix: string): Promise<string | null> {
    let newest: { path: string; mtime: number } | null = null;

    for await (const entry of Deno.readDir(CACHE_DIR)) {
        if (!entry.isFile || !entry.name.startsWith(prefix + ".") || entry.name.endsWith(".metadata.json")) {
            continue;
        }

        const path = `${CACHE_DIR}\\${entry.name}`;
        const stat = await Deno.stat(path);
        const mtime = stat.mtime?.getTime() ?? 0;

        if (!newest || mtime > newest.mtime) {
            newest = { path, mtime };
        }
    }

    return newest?.path ?? null;
}

function flattenCandidates(value: YouTubeCandidate | null | undefined): YouTubeCandidate[] {
    if (!value) {
        return [];
    }

    if (Array.isArray(value.entries)) {
        return value.entries.flatMap((entry) => flattenCandidates(entry));
    }

    return stringValue(value.title) || stringValue(value.fulltitle) || stringValue(value.id) ? [value] : [];
}

function parseCandidates(stdout: string): YouTubeCandidate[] {
    const candidates: YouTubeCandidate[] = [];

    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        try {
            candidates.push(...flattenCandidates(JSON.parse(trimmed) as YouTubeCandidate));
        } catch {
            // yt-dlp writes one JSON object per line; skip any progress noise defensively.
        }
    }

    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        const key = candidateDownloadUrl(candidate) || stringValue(candidate.id);

        if (!key || seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

function candidateTitle(candidate: YouTubeCandidate): string {
    return stringValue(candidate.fulltitle) || stringValue(candidate.title) || stringValue(candidate.alt_title);
}

function candidateUploader(candidate: YouTubeCandidate): string {
    return stringValue(candidate.uploader)
        || stringValue(candidate.channel)
        || stringValue(candidate.artist)
        || stringValue(candidate.creator);
}

function isOfficialAudioCandidate(candidate: YouTubeCandidate): boolean {
    const title = candidateTitle(candidate);
    const uploader = candidateUploader(candidate);
    const description = stringValue(candidate.description);
    const normalizedUploader = normalizeText(uploader);
    const normalizedDescription = normalizeText(description);

    return normalizedUploader.endsWith(" topic")
        || title.toLowerCase().includes("official audio")
        || normalizedDescription.includes("provided to youtube by")
        || normalizedDescription.includes("auto generated by youtube");
}

function candidateDuration(candidate: YouTubeCandidate): number {
    return numberValue(candidate.duration);
}

function candidateDownloadUrl(candidate: YouTubeCandidate): string {
    for (const value of [candidate.webpage_url, candidate.original_url]) {
        const url = stringValue(value);

        if (/^https?:\/\//i.test(url)) {
            return url;
        }
    }

    const id = stringValue(candidate.id);

    return id ? `https://www.youtube.com/watch?v=${encodeURIComponent(id)}` : "";
}

function dedupeCandidates(candidates: YouTubeCandidate[]): YouTubeCandidate[] {
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        const key = candidateDownloadUrl(candidate) || stringValue(candidate.id);

        if (!key || seen.has(key)) {
            return false;
        }

        seen.add(key);
        return true;
    });
}

async function getCandidatesForSearch(ytDlp: string, query: string, count: number): Promise<YouTubeCandidate[]> {
    const output = await commandOutput(ytDlp, [
        "--dump-json",
        "--skip-download",
        `ytsearch${count}:${query}`,
    ]);

    if (output.code !== 0) {
        throw new Error(
            `Could not search YouTube for "${query}": ${
                output.stderr.trim() || output.stdout.trim() || "yt-dlp metadata lookup failed"
            }.`
        );
    }

    return parseCandidates(output.stdout).slice(0, count);
}

async function getCandidateMetadata(ytDlp: string, request: ResolveRequest): Promise<YouTubeCandidate[]> {
    const title = titleFromRequest(request);
    const artist = artistFromRequest(request);
    const topicQuery = artist ? `${title} ${artist} topic` : `${request.query} topic`;
    const topicCandidates = await getCandidatesForSearch(ytDlp, topicQuery, TOPIC_SEARCH_RESULT_COUNT);

    if (topicCandidates.some((candidate) => scoreCandidate(request, candidate).ok)) {
        return topicCandidates;
    }

    const generalCandidates = await getCandidatesForSearch(ytDlp, request.query, SEARCH_RESULT_COUNT);
    const candidates = dedupeCandidates([...topicCandidates, ...generalCandidates]);

    if (!candidates.length) {
        throw new Error(`Could not find any YouTube results for "${request.query}".`);
    }

    return candidates;
}

function scoreCandidate(request: ResolveRequest, candidate: YouTubeCandidate): ScoredCandidate {
    const expectedTitle = titleFromRequest(request);
    const expectedArtist = artistFromRequest(request);
    const title = candidateTitle(candidate);
    const uploader = candidateUploader(candidate);
    const haystack = `${title} ${uploader} ${stringValue(candidate.artist)} ${stringValue(candidate.creator)}`;
    const titleScore = tokenCoverage(tokens(expectedTitle), tokens(title));
    const artistTokens = tokens(expectedArtist);
    const artistScore = artistTokens.length ? tokenCoverage(artistTokens, tokens(haystack)) : 1;
    const expectedDurationSec = request.durationMs > 0 ? request.durationMs / 1000 : 0;
    const durationSec = candidateDuration(candidate);
    let durationScore = 1;
    const reasons: string[] = [];
    const officialAudio = isOfficialAudioCandidate(candidate);

    if (expectedDurationSec > 0) {
        if (durationSec <= 0) {
            durationScore = 0;
            reasons.push("missing duration");
        } else {
            const delta = Math.abs(durationSec - expectedDurationSec);
            const allowed = Math.min(45, Math.max(12, expectedDurationSec * 0.08));
            durationScore = Math.max(0, 1 - delta / allowed);

            if (delta > allowed) {
                reasons.push(`duration differs by ${Math.round(delta)}s`);
            }
        }
    }

    const versionMismatch = findVersionMismatch(expectedTitle, title);

    if (versionMismatch) {
        reasons.push(`looks like a ${versionMismatch} version`);
    }

    if (titleScore < 0.5) {
        reasons.push(`title match ${Math.round(titleScore * 100)}%`);
    }

    const strongTitleAndDurationMatch = titleScore >= 0.82 && durationScore >= 0.75;

    if (artistTokens.length && artistScore < 0.34 && !strongTitleAndDurationMatch) {
        reasons.push(`artist match ${Math.round(artistScore * 100)}%`);
    }

    const score = Math.min(
        1,
        titleScore * 0.55 + artistScore * 0.25 + durationScore * 0.2 + (officialAudio ? OFFICIAL_AUDIO_BONUS : 0)
    );
    const ok = reasons.length === 0 && score >= 0.62;

    if (!ok && reasons.length === 0) {
        reasons.push(`confidence ${Math.round(score * 100)}%`);
    }

    return {
        candidate,
        url: candidateDownloadUrl(candidate),
        ok,
        score,
        titleScore,
        artistScore,
        durationScore,
        officialAudio,
        reasons,
    };
}

function selectBestCandidate(request: ResolveRequest, candidates: YouTubeCandidate[]): ScoredCandidate {
    const scored = candidates
        .map((candidate) => scoreCandidate(request, candidate))
        .filter((candidate) => candidate.url)
        .sort((a, b) => b.score - a.score);
    const accepted = scored.find((candidate) => candidate.ok);

    if (accepted) {
        return accepted;
    }

    const best = scored[0];

    if (!best) {
        throw new Error(`Could not use the YouTube search results for "${request.query}": none had a downloadable URL.`);
    }

    const name = candidateTitle(best.candidate) || "unknown title";
    const uploader = candidateUploader(best.candidate) || "unknown uploader";
    const duration = candidateDuration(best.candidate);
    const durationText = duration > 0 ? `${Math.round(duration)}s` : "unknown duration";
    const reason = best.reasons.join("; ") || "it did not meet the confidence threshold";
    throw new Error(
        `Could not verify YouTube audio for "${request.query}". Best result was "${name}" by ${uploader} (${durationText}), but rejected because ${reason}.`
    );
}

async function writeMatchMetadata(cacheKey: string, request: ResolveRequest, match: ScoredCandidate, file: string) {
    const metadata = {
        request,
        file,
        score: match.score,
        titleScore: match.titleScore,
        artistScore: match.artistScore,
        durationScore: match.durationScore,
        officialAudio: match.officialAudio,
        candidate: {
            title: candidateTitle(match.candidate),
            uploader: candidateUploader(match.candidate),
            duration: candidateDuration(match.candidate),
            url: match.url,
        },
    };

    try {
        await Deno.writeTextFile(`${CACHE_DIR}\\${cacheKey}.metadata.json`, JSON.stringify(metadata, null, 2));
    } catch {
        // Sidecar metadata is useful for debugging, but not required for playback.
    }
}

async function resolveAudio(request: ResolveRequest): Promise<ResolveResult> {
    await Deno.mkdir(CACHE_DIR, { recursive: true });

    const ytDlp = await findExecutable("yt-dlp.exe", "EJB_YTDLP");
    const cacheKey = sanitize(`${request.trackKey || request.query}.yt-verified-v3`);
    const existing = await newestMatchingFile(cacheKey);

    if (existing) {
        return resultForFile(existing, request);
    }

    const candidates = await getCandidateMetadata(ytDlp, request);
    const match = selectBestCandidate(request, candidates);
    const outputTemplate = `${CACHE_DIR}\\${cacheKey}.%(ext)s`;
    const args = [
        "--no-playlist",
        "--format",
        "bestaudio/best",
        "--output",
        outputTemplate,
        "--print",
        "after_move:filepath",
        match.url,
    ];
    const output = await commandOutput(ytDlp, args);

    if (output.code !== 0) {
        throw new Error(
            `Could not download verified YouTube audio "${candidateTitle(match.candidate)}": ${
                output.stderr.trim() || output.stdout.trim() || "yt-dlp failed"
            }.`
        );
    }

    const printedPath = output.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .findLast((line) => line.includes(CACHE_DIR));
    const resolved = printedPath && await exists(printedPath)
        ? printedPath
        : await newestMatchingFile(cacheKey);

    if (!resolved) {
        throw new Error(`yt-dlp selected "${candidateTitle(match.candidate)}", but no audio file was produced.`);
    }

    await writeMatchMetadata(cacheKey, request, match, resolved);
    return resultForFile(resolved, request, match);
}

function resultForFile(file: string, request: ResolveRequest, match?: ScoredCandidate): ResolveResult {
    const name = file.split(/[\\/]/).pop() ?? "";

    return {
        ok: true,
        query: request.query,
        file,
        url: `http://127.0.0.1:${PORT}/audio/${encodeURIComponent(name)}`,
        matchedTitle: match ? candidateTitle(match.candidate) : undefined,
        matchedUploader: match ? candidateUploader(match.candidate) : undefined,
        matchedDuration: match ? candidateDuration(match.candidate) : undefined,
        confidence: match ? Math.round(match.score * 100) / 100 : undefined,
        officialAudio: match?.officialAudio,
    };
}

async function handleAudio(pathname: string): Promise<Response> {
    const encodedName = pathname.slice("/audio/".length);
    const name = decodeURIComponent(encodedName);
    const safeName = name.split(/[\\/]/).pop() ?? "";
    const file = `${CACHE_DIR}\\${safeName}`;

    if (!await exists(file)) {
        return json({ ok: false, error: "Not found." }, 404);
    }

    return audioResponse(await Deno.readFile(file), contentTypeFor(file));
}

async function handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "GET, OPTIONS",
                "access-control-allow-headers": "*",
            },
        });
    }

    const url = new URL(request.url);

    try {
        if (url.pathname === "/health") {
            return json({
                ok: true,
                cacheDir: CACHE_DIR,
                ytDlp: await findExecutable("yt-dlp.exe", "EJB_YTDLP"),
            });
        }

        if (url.pathname === "/resolve") {
            const query = url.searchParams.get("query")?.trim();
            const trackKey = url.searchParams.get("trackKey")?.trim() ?? "";
            const title = url.searchParams.get("title")?.trim() ?? "";
            const artist = url.searchParams.get("artist")?.trim() ?? "";
            const durationMs = numberValue(url.searchParams.get("durationMs"));

            if (!query) {
                return json({ ok: false, error: "Missing query." }, 400);
            }

            return json(await resolveAudio({
                query,
                trackKey: trackKey || query,
                title,
                artist,
                durationMs,
            }));
        }

        if (url.pathname.startsWith("/audio/")) {
            return handleAudio(url.pathname);
        }

        return json({ ok: false, error: "Unknown endpoint." }, 404);
    } catch (error) {
        console.error(error);
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
}

console.log(`Eternal Jukebox seamless helper listening on http://127.0.0.1:${PORT}`);
Deno.serve({ port: PORT, hostname: "127.0.0.1" }, handle);
