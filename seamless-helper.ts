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
    error?: string;
};

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

async function findOptionalExecutable(name: string, envName: string): Promise<string | null> {
    try {
        return await findExecutable(name, envName);
    } catch {
        return null;
    }
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
        if (!entry.isFile || !entry.name.startsWith(prefix + ".")) {
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

async function resolveAudio(query: string, trackKey: string): Promise<ResolveResult> {
    await Deno.mkdir(CACHE_DIR, { recursive: true });

    const ytDlp = await findExecutable("yt-dlp.exe", "EJB_YTDLP");
    const cacheKey = sanitize(`${trackKey || query}.yt-original`);
    const existing = await newestMatchingFile(cacheKey);

    if (existing) {
        return resultForFile(existing, query);
    }

    const outputTemplate = `${CACHE_DIR}\\${cacheKey}.%(ext)s`;
    const search = `ytsearch1:${query}`;
    const args = [
        "--no-playlist",
        "--default-search",
        "ytsearch1",
        "--format",
        "bestaudio/best",
        "--output",
        outputTemplate,
        "--print",
        "after_move:filepath",
        search,
    ];
    const output = await commandOutput(ytDlp, args);

    if (output.code !== 0) {
        throw new Error(output.stderr.trim() || output.stdout.trim() || "yt-dlp failed.");
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
        throw new Error("yt-dlp finished, but no audio file was produced.");
    }

    return resultForFile(resolved, query);
}

function resultForFile(file: string, query: string): ResolveResult {
    const name = file.split(/[\\/]/).pop() ?? "";

    return {
        ok: true,
        query,
        file,
        url: `http://127.0.0.1:${PORT}/audio/${encodeURIComponent(name)}`,
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
                ffmpeg: await findOptionalExecutable("ffmpeg.exe", "EJB_FFMPEG"),
            });
        }

        if (url.pathname === "/resolve") {
            const query = url.searchParams.get("query")?.trim();
            const trackKey = url.searchParams.get("trackKey")?.trim() ?? "";

            if (!query) {
                return json({ ok: false, error: "Missing query." }, 400);
            }

            return json(await resolveAudio(query, trackKey || query));
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
