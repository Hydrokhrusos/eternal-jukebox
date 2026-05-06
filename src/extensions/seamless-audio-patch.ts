// @ts-nocheck
(() => {
    const PATCH_FLAG = "__eternalJukboxSeamlessStableV9";
    const SCHEDULE_AHEAD_MS = 140;
    const TICK_MS = 16;
    const UI_POLL_MS = 125;
    const VOLUME_POLL_MS = 250;
    const START_DELAY_SEC = 0.035;
    const CROSSFADE_SEC = 0.010;
    const MIN_BEATS_BEFORE_BRANCHING = 5;
    const SPOTIFY_NORMALIZATION_TARGET_DB = -23;
    const MAX_NORMALIZATION_GAIN = 1;
    const SPOTIFY_VOLUME_CURVE_EXPONENT = 3;
    const SPOTIFY_OUTPUT_TRIM = 0.32;
    const HELPER_BASE = "http://127.0.0.1:43173";

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const state = window.__ejbSeamlessAudio ?? {
        buffers: new Map(),
        loadingKeys: new Set(),
        activeDriver: null,
        audioContext: null,
        originalSeekTo: null,
        originalPlayerSeek: null,
        originalGetProgress: null,
        originalPlayerGetProgress: null,
        originalPause: null,
        originalPlayerPause: null,
        originalResume: null,
        originalPlayerResume: null,
        originalPlay: null,
        originalPlayerPlay: null,
        originalTogglePlay: null,
        originalPlayerTogglePlay: null,
        suppressTransportPatch: false,
        transportEventsPatched: false,
    };

    window.__ejbSeamlessAudio = state;
    state.buffers ??= new Map();
    state.loadingKeys ??= new Set();

    function notify(message, isError = false) {
        try {
            Spicetify?.showNotification?.(message, isError);
        } catch {
            console[isError ? "error" : "log"](message);
        }
    }

    function getAudioContext() {
        if (!AudioContextClass) {
            throw new Error("Web Audio is not available in this Spotify build.");
        }

        if (!state.audioContext || state.audioContext.state === "closed") {
            state.audioContext = new AudioContextClass({ latencyHint: "interactive" });
        }

        return state.audioContext;
    }

    function createSubject() {
        const observers = new Set();

        return {
            next(value) {
                for (const observer of observers) {
                    try {
                        if (typeof observer === "function") {
                            observer(value);
                        } else {
                            observer?.next?.(value);
                        }
                    } catch (error) {
                        console.error(error);
                    }
                }
            },
            asObservable() {
                return {
                    subscribe(observer) {
                        observers.add(observer);
                        return {
                            unsubscribe() {
                                observers.delete(observer);
                            },
                        };
                    },
                };
            },
        };
    }

    function getTrackKey(songState = window.jukebox?.songState) {
        const track = songState?.track ?? Spicetify?.Player?.data?.item;
        return track?.uri
            ?? track?.metadata?.uri
            ?? track?.metadata?.link
            ?? track?.id
            ?? null;
    }

    function getTrackLabel(songState = window.jukebox?.songState) {
        const track = songState?.track ?? Spicetify?.Player?.data?.item;
        const title = track?.metadata?.title ?? track?.name ?? "track";
        const artist = track?.metadata?.artist_name ?? track?.artists?.[0]?.name;
        return artist ? `${title} - ${artist}` : title;
    }

    function getSpotifyProgress() {
        const getProgress = state.originalPlayerGetProgress ?? Spicetify?.Player?.getProgress;
        return Number(getProgress?.() ?? 0);
    }

    function clamp(value, min, max) {
        const numeric = Number(value);

        if (!Number.isFinite(numeric)) {
            return min;
        }

        return Math.max(min, Math.min(max, numeric));
    }

    function firstFinitePositive(values) {
        for (const value of values) {
            const numeric = Number(value);

            if (Number.isFinite(numeric) && numeric > 0) {
                return numeric;
            }
        }

        return 0;
    }

    function getDurationMs(driver = state.activeDriver) {
        const track = driver?.songState?.track ?? Spicetify?.Player?.data?.item;
        return firstFinitePositive([
            driver?.buffer?.duration ? driver.buffer.duration * 1000 : 0,
            track?.duration?.milliseconds,
            track?.duration_ms,
            track?.metadata?.duration,
            track?.metadata?.duration_ms,
            Spicetify?.Player?.data?.item?.duration?.milliseconds,
            Spicetify?.Player?.data?.item?.duration_ms,
            Spicetify?.Player?.data?.item?.metadata?.duration,
        ]);
    }

    function formatTime(ms) {
        const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = String(totalSeconds % 60).padStart(2, "0");

        return hours > 0
            ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
            : `${minutes}:${seconds}`;
    }

    function normalizeVolume(value) {
        const numeric = Number(value);

        if (!Number.isFinite(numeric)) {
            return null;
        }

        return Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric));
    }

    function getSpotifyNormalizationGain(songState) {
        const loudnessDb = Number(songState?.analysis?.track?.loudness);

        if (!Number.isFinite(loudnessDb)) {
            return 1;
        }

        return Math.min(
            MAX_NORMALIZATION_GAIN,
            Math.pow(10, (SPOTIFY_NORMALIZATION_TARGET_DB - loudnessDb) / 20)
        );
    }

    function spotifyVolumeToGain(volume) {
        return Math.pow(clamp(volume, 0, 1), SPOTIFY_VOLUME_CURVE_EXPONENT);
    }

    async function getSpotifyVolume() {
        for (const candidate of [Spicetify?.Platform?.PlayerAPI, Spicetify?.Player]) {
            if (typeof candidate?.getVolume !== "function") {
                continue;
            }

            try {
                const volume = normalizeVolume(await candidate.getVolume.call(candidate));

                if (volume !== null) {
                    return volume;
                }
            } catch {}
        }

        return null;
    }

    function callSafely(target, method, ...args) {
        const fn = target?.[method];

        if (typeof fn !== "function") {
            return false;
        }

        try {
            const result = fn.call(target, ...args);
            result?.catch?.(console.error);
            return true;
        } catch (error) {
            console.error(error);
            return false;
        }
    }

    function pauseSpotifyBackend() {
        state.suppressTransportPatch = true;

        try {
            return callSafely(Spicetify?.Platform?.PlayerAPI, "pause")
                || callSafely(Spicetify?.Player, "pause");
        } finally {
            state.suppressTransportPatch = false;
        }
    }

    function getNowPlayingRoot() {
        return document.querySelector('[data-testid="now-playing-bar"]')
            ?? document.querySelector(".Root__now-playing-bar")
            ?? document.querySelector(".main-nowPlayingBar-container")
            ?? document.querySelector(".now-playing-bar")
            ?? document.querySelector(".player-controls");
    }

    function getPlayPauseButton(root = getNowPlayingRoot()) {
        return root?.querySelector?.('button[data-testid="control-button-playpause"]')
            ?? root?.querySelector?.("button.main-playPauseButton-button")
            ?? root?.querySelector?.('button[aria-label="Pause"], button[aria-label="Play"]')
            ?? null;
    }

    function isInTransportArea(element) {
        return Boolean(element?.closest?.(
            '[data-testid="now-playing-bar"], .Root__now-playing-bar, .main-nowPlayingBar-container, .now-playing-bar, .player-controls'
        ));
    }

    function isEditableTarget(element) {
        return Boolean(
            element?.isContentEditable
            || ["INPUT", "TEXTAREA", "SELECT"].includes(element?.tagName)
            || element?.closest?.("[contenteditable='true']")
        );
    }

    function setRangeAttributes(element, progressMs, durationMs, percent) {
        const maxAttr = Number(element.getAttribute("aria-valuemax"));
        const max = Number.isFinite(maxAttr) && maxAttr > 0 ? maxAttr : durationMs;
        const value = max <= 100 ? percent : max * (percent / 100);

        element.setAttribute("aria-valuenow", String(Math.round(value)));
        element.setAttribute("aria-valuetext", `${formatTime(progressMs)} of ${formatTime(durationMs)}`);
    }

    function paintProgressElement(element, percent) {
        const className = String(element.className?.baseVal ?? element.className ?? "");
        const existingStyle = String(element.getAttribute("style") ?? "");
        const transformDriven = /progress-bar__fg|foreground|filled/i.test(className)
            || existingStyle.includes("translate");

        if (transformDriven) {
            element.style.width = "100%";
            element.style.transform = `translateX(${percent - 100}%)`;
            return;
        }

        element.style.width = `${percent}%`;
    }

    function updatePlayerProgressUi(driver = state.activeDriver) {
        if (!driver?.active) {
            return;
        }

        const root = getNowPlayingRoot();

        if (!root) {
            return;
        }

        const durationMs = getDurationMs(driver);

        if (durationMs <= 0) {
            return;
        }

        const progressMs = clamp(driver.getProgress(), 0, durationMs);
        const percent = clamp((progressMs / durationMs) * 100, 0, 100);

        root.querySelector('[data-testid="playback-position"]')
            ?.replaceChildren(document.createTextNode(formatTime(progressMs)));
        root.querySelector('[data-testid="playback-duration"]')
            ?.replaceChildren(document.createTextNode(formatTime(durationMs)));

        const progressContainers = new Set([
            root.querySelector('[data-testid="progress-bar"]'),
            root.querySelector(".playback-progressbar"),
            root.querySelector(".playback-bar .progress-bar"),
            root.querySelector(".progress-bar"),
        ].filter(Boolean));

        for (const container of progressContainers) {
            container.style.setProperty("--ejb-progress-percent", `${percent}%`);
            container.querySelectorAll?.('[role="slider"], [role="progressbar"]').forEach((element) => {
                setRangeAttributes(element, progressMs, durationMs, percent);
            });
            container.querySelectorAll?.("input[type='range']").forEach((input) => {
                input.max = String(durationMs);
                input.value = String(progressMs);
            });
            container.querySelectorAll?.(".progress-bar__fg, [class*='progressBarForeground'], [class*='progress-bar__fg']")
                .forEach((element) => paintProgressElement(element, percent));
            container.querySelectorAll?.(".progress-bar__slider, [class*='progressBarSlider'], [class*='progress-bar__slider']")
                .forEach((element) => {
                    element.style.left = `${percent}%`;
                });
        }
    }

    function updateTransportUi(driver = state.activeDriver) {
        const button = getPlayPauseButton();

        if (!button || !driver) {
            return;
        }

        const label = driver.paused ? "Play" : "Pause";
        button.setAttribute("aria-label", label);
        button.setAttribute("title", label);
    }

    function clearBeatPlaying(songState) {
        for (const beat of songState?.graph?.beats ?? []) {
            beat.isPlaying = false;
        }
    }

    function findBeatAt(songState, progressMs) {
        for (const beat of songState?.graph?.beats ?? []) {
            if (progressMs >= beat.start && progressMs <= beat.end) {
                return beat;
            }
        }

        return songState?.graph?.beats?.[0] ?? null;
    }

    function stopNode(node, when = 0) {
        try {
            node?.stop?.(when);
        } catch {}
    }

    function setEdgePlaying(edge, isPlaying) {
        if (!edge) {
            return;
        }

        edge.isPlaying = isPlaying;
        edge.source.isPlaying = isPlaying;
        edge.destination.isPlaying = isPlaying;
    }

    class SeamlessWebAudioDriver {
        constructor(jukebox, originalDriver, buffer) {
            this.jukebox = jukebox;
            this.songState = jukebox.songState;
            this.settings = jukebox.settings;
            this.buffer = buffer;
            this.context = getAudioContext();
            this.output = this.context.createGain();
            this.output.gain.value = 1;
            this.normalizationGain = getSpotifyNormalizationGain(this.songState);
            this.output.connect(this.context.destination);
            this.currentBeat = null;
            this.bouncing = false;
            this.bounceSeed = null;
            this.bounceCount = 0;
            this.lastBranch = null;
            this.beatsSinceLastBranch = 0;
            this.progressPoller = 0;
            this.uiPoller = 0;
            this.volumePoller = 0;
            this.active = null;
            this.pending = null;
            this.paused = false;
            this.isProcessing = false;
            this.onProgressSubject = createSubject();
            this.onProgress$ = this.onProgressSubject.asObservable();
            this.originalShouldRandomBranch = originalDriver?.shouldRandomBranch;
            this.onBounceKeyDown = (event) => {
                if (event.key === "Shift") {
                    this.bouncing = true;
                }
            };
            this.onBounceKeyUp = (event) => {
                if (event.key === "Shift") {
                    this.bouncing = false;
                }
            };
        }

        async start() {
            await this.context.resume?.();
            this.paused = false;
            document.addEventListener("keydown", this.onBounceKeyDown);
            document.addEventListener("keyup", this.onBounceKeyUp);
            pauseSpotifyBackend();
            await this.syncVolume();
            this.seekTo(getSpotifyProgress());
            this.progressPoller = window.setInterval(() => this.tick(), TICK_MS);
            this.uiPoller = window.setInterval(() => this.syncPlayerUi(), UI_POLL_MS);
            this.volumePoller = window.setInterval(() => this.syncVolume().catch(console.error), VOLUME_POLL_MS);
            this.syncPlayerUi();
        }

        stop() {
            window.clearInterval(this.progressPoller);
            window.clearInterval(this.uiPoller);
            window.clearInterval(this.volumePoller);
            this.progressPoller = 0;
            this.uiPoller = 0;
            this.volumePoller = 0;
            document.removeEventListener("keydown", this.onBounceKeyDown);
            document.removeEventListener("keyup", this.onBounceKeyUp);
            stopNode(this.active?.source);
            stopNode(this.pending?.source);
            this.active = null;
            this.pending = null;
            clearBeatPlaying(this.songState);
            setEdgePlaying(this.lastBranch, false);
            this.output.disconnect();

            if (state.activeDriver === this) {
                state.activeDriver = null;
            }
        }

        async pause() {
            if (this.paused) {
                return;
            }

            this.paused = true;
            await this.context.suspend?.();
            this.emitProgress();
            this.syncPlayerUi();
        }

        async resume() {
            if (!this.paused) {
                return;
            }

            this.paused = false;
            await this.context.resume?.();
            pauseSpotifyBackend();
            this.emitProgress();
            this.syncPlayerUi();
        }

        async togglePause() {
            if (this.paused) {
                await this.resume();
                return;
            }

            await this.pause();
        }

        async syncVolume() {
            const volume = await getSpotifyVolume();

            if (volume !== null) {
                this.output.gain.setTargetAtTime(
                    spotifyVolumeToGain(volume) * this.normalizationGain * SPOTIFY_OUTPUT_TRIM,
                    this.context.currentTime,
                    0.015
                );
            }
        }

        syncPlayerUi() {
            updatePlayerProgressUi(this);
            updateTransportUi(this);
        }

        seekTo(progressMs) {
            const safeProgressMs = Math.max(0, Math.min(Number(progressMs) || 0, this.buffer.duration * 1000 - 1));
            const beat = findBeatAt(this.songState, safeProgressMs);
            const startAt = this.context.currentTime + (this.paused ? 0 : START_DELAY_SEC);

            stopNode(this.active?.source);
            stopNode(this.pending?.source);
            clearBeatPlaying(this.songState);
            setEdgePlaying(this.lastBranch, false);
            this.pending = null;
            this.active = this.createSource(safeProgressMs, startAt, 1);
            this.currentBeat = beat;

            if (this.currentBeat) {
                this.currentBeat.isPlaying = true;
            }

            this.emitProgress();
            this.syncPlayerUi();
        }

        createSource(audioStartMs, when, gainValue) {
            const source = this.context.createBufferSource();
            const gain = this.context.createGain();
            const offsetSec = Math.max(0, audioStartMs / 1000);

            source.buffer = this.buffer;
            gain.gain.setValueAtTime(gainValue, when);
            source.connect(gain);
            gain.connect(this.output);
            source.start(when, offsetSec);

            return {
                source,
                gain,
                audioStartMs,
                ctxStart: when,
            };
        }

        getProgress() {
            if (!this.active) {
                return 0;
            }

            return clamp(
                this.active.audioStartMs + (this.context.currentTime - this.active.ctxStart) * 1000,
                0,
                this.buffer.duration * 1000
            );
        }

        tick() {
            if (this.paused || !this.active || this.context.currentTime < this.active.ctxStart || this.isProcessing) {
                return;
            }

            this.isProcessing = true;

            try {
                this.finishPendingIfReady();
                this.scheduleNextIfNeeded();
            } catch (error) {
                console.error(error);
            } finally {
                this.isProcessing = false;
            }
        }

        finishPendingIfReady() {
            if (!this.pending || this.context.currentTime < this.pending.switchCtx) {
                return;
            }

            if (this.pending.isBranch) {
                this.active = {
                    source: this.pending.source,
                    gain: this.pending.gain,
                    audioStartMs: this.pending.audioStartMs,
                    ctxStart: this.pending.ctxStart,
                };
            }

            this.finishBeat(this.pending.nextBeat);
            this.pending = null;
        }

        scheduleNextIfNeeded() {
            if (this.pending || !this.currentBeat) {
                return;
            }

            const progress = this.getProgress();
            const remainingMs = this.currentBeat.end - progress;

            if (remainingMs > SCHEDULE_AHEAD_MS) {
                return;
            }

            if (remainingMs < -40) {
                this.finishBeat(findBeatAt(this.songState, progress));
                return;
            }

            this.beatsSinceLastBranch += 1;
            const previousBeat = this.currentBeat;
            const nextBeat = this.chooseNextBeat();

            if (!nextBeat) {
                this.stop();
                return;
            }

            const switchCtx = this.context.currentTime + Math.max(0, remainingMs) / 1000;
            const isBranch = previousBeat.index + 1 !== nextBeat.index;

            if (!isBranch) {
                this.pending = {
                    isBranch: false,
                    nextBeat,
                    switchCtx,
                };
                return;
            }

            this.scheduleBranch(nextBeat, switchCtx);
            this.emitProgress();
        }

        scheduleBranch(nextBeat, switchCtx) {
            const fadeSec = Math.min(
                CROSSFADE_SEC,
                Math.max(0, switchCtx - this.context.currentTime - 0.004),
                Math.max(0, nextBeat.start / 1000)
            );
            const startCtx = switchCtx - fadeSec;
            const startAudioMs = Math.max(0, nextBeat.start - fadeSec * 1000);
            const nextSource = this.createSource(startAudioMs, startCtx, 0);
            const oldGain = this.active.gain.gain;
            const newGain = nextSource.gain.gain;

            oldGain.cancelScheduledValues(startCtx);
            oldGain.setValueAtTime(oldGain.value || 1, startCtx);
            oldGain.linearRampToValueAtTime(0, switchCtx);
            newGain.cancelScheduledValues(startCtx);
            newGain.setValueAtTime(0, startCtx);
            newGain.linearRampToValueAtTime(1, switchCtx);
            stopNode(this.active.source, switchCtx + 0.025);

            this.pending = {
                isBranch: true,
                nextBeat,
                switchCtx,
                source: nextSource.source,
                gain: nextSource.gain,
                audioStartMs: startAudioMs,
                ctxStart: startCtx,
            };
        }

        finishBeat(nextBeat) {
            if (this.lastBranch) {
                setEdgePlaying(this.lastBranch, false);
            }

            const previousBeat = this.currentBeat;

            if (previousBeat) {
                previousBeat.isPlaying = false;
            }

            this.currentBeat = nextBeat;

            if (!this.currentBeat) {
                return;
            }

            this.currentBeat.playCount += 1;
            this.songState.beatsPlayed += 1;
            this.currentBeat.isPlaying = true;
            this.emitProgress();
        }

        emitProgress() {
            this.onProgressSubject.next();
            this.jukebox.songStateSubject?.next?.({ ...this.songState });
            this.jukebox.statsChangedSubject?.next?.({
                beatsPlayed: this.songState?.beatsPlayed ?? 0,
                currentRandomBranchChance: this.songState?.currentRandomBranchChance ?? 0,
                listenTime: this.songState ? Date.now() - this.songState.startTime : 0,
            });
        }

        chooseNextBeat() {
            const currentBeat = this.currentBeat;

            if (!currentBeat) {
                return null;
            }

            if (this.bouncing) {
                if (this.bounceSeed === null) {
                    this.bounceSeed = currentBeat;
                    this.bounceCount = 0;
                }

                return this.bounceCount++ % 2 === 1
                    ? this.selectNextNeighbor(this.bounceSeed)
                    : this.bounceSeed;
            }

            if (this.bounceSeed !== null) {
                const next = this.bounceSeed;
                this.bounceSeed = null;
                return next;
            }

            const nextIndex = currentBeat.index + 1;
            const beats = this.songState?.graph?.beats ?? [];

            if (nextIndex >= beats.length) {
                return null;
            }

            return this.selectRandomNextBeat(beats[nextIndex]);
        }

        selectRandomNextBeat(beat) {
            if (!beat?.neighbours?.length || !this.shouldRandomBranch(beat)) {
                return beat;
            }

            const edge = beat.neighbours.shift();
            beat.neighbours.push(edge);
            this.beatsSinceLastBranch = 0;
            this.lastBranch = edge;
            setEdgePlaying(edge, true);
            return edge.destination;
        }

        selectNextNeighbor(beat) {
            if (!beat?.neighbours?.length) {
                return beat;
            }

            const edge = beat.neighbours.shift();
            beat.neighbours.push(edge);
            this.lastBranch = edge;
            setEdgePlaying(edge, true);
            return edge.destination;
        }

        shouldRandomBranch(beat) {
            if (typeof this.originalShouldRandomBranch === "function") {
                return this.originalShouldRandomBranch.call(this, beat);
            }

            const elapsed = Date.now() - this.songState.startTime;

            if (this.settings.maxJukeboxPlayTime > 0 && elapsed > this.settings.maxJukeboxPlayTime) {
                this.songState.currentRandomBranchChance = 0;
                return false;
            }

            if (
                beat.index === this.songState.graph.lastBranchPoint
                && this.settings.alwaysFollowLastBranch
                && (this.settings.maxJukeboxPlayTime <= 0 || elapsed <= this.settings.maxJukeboxPlayTime)
            ) {
                return true;
            }

            if (this.beatsSinceLastBranch <= MIN_BEATS_BEFORE_BRANCHING) {
                return false;
            }

            this.songState.currentRandomBranchChance = Math.min(
                this.songState.currentRandomBranchChance + this.settings.randomBranchChanceDelta,
                this.settings.maxRandomBranchChance
            );

            const shouldBranch = Math.random() < this.songState.currentRandomBranchChance;

            if (shouldBranch) {
                this.songState.currentRandomBranchChance = this.settings.minRandomBranchChance;
            }

            return shouldBranch;
        }
    }

    async function decodeAudioData(arrayBuffer) {
        const context = getAudioContext();
        await context.resume?.();
        return context.decodeAudioData(arrayBuffer.slice(0));
    }

    async function isHelperRunning(timeoutMs = 600) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(`${HELPER_BASE}/health`, {
                cache: "no-store",
                signal: controller.signal,
            });

            if (!response.ok) {
                return false;
            }

            const data = await response.json().catch(() => null);
            return Boolean(data?.ok);
        } catch {
            return false;
        } finally {
            window.clearTimeout(timer);
        }
    }

    async function loadAudioUrl(url, key) {
        notify("Fetching Web Audio source...");
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Audio request failed: ${response.status}`);
        }

        const buffer = await decodeAudioData(await response.arrayBuffer());
        state.buffers.set(key, {
            buffer,
            label: url,
        });
        notify(`Loaded Web Audio for ${getTrackLabel()}.`);
    }

    async function loadAudioFromHelper(songState) {
        const key = getTrackKey(songState);

        if (!key || state.buffers.has(key) || state.loadingKeys.has(key)) {
            return state.buffers.has(key);
        }

        state.loadingKeys.add(key);

        try {
            if (!await isHelperRunning()) {
                throw new Error("Seamless helper is not running.");
            }

            const query = getTrackLabel(songState);
            const resolveUrl = new URL(`${HELPER_BASE}/resolve`);
            resolveUrl.searchParams.set("query", query);
            resolveUrl.searchParams.set("trackKey", key);

            notify(`Resolving audio for ${query}...`);
            const response = await fetch(resolveUrl);

            if (!response.ok) {
                throw new Error(`Helper returned ${response.status}`);
            }

            const data = await response.json();

            if (!data?.ok || !data.url) {
                throw new Error(data?.error || "Helper did not return an audio URL.");
            }

            await loadAudioUrl(data.url, key);
            return true;
        } catch (error) {
            console.error(error);
            return false;
        } finally {
            state.loadingKeys.delete(key);
        }
    }

    function getLoadedAudio(songState) {
        const key = getTrackKey(songState);
        return key ? state.buffers.get(key) : null;
    }

    function disableJukeboxWithSeamlessError(jukebox, message) {
        notify(message, true);
        jukebox?.disable?.();
    }

    async function switchToSeamless(jukebox, announceFailure = false) {
        if (!jukebox?.songState) {
            return false;
        }

        let loaded = getLoadedAudio(jukebox?.songState);

        if (!loaded?.buffer) {
            const didLoad = await loadAudioFromHelper(jukebox.songState);
            loaded = didLoad ? getLoadedAudio(jukebox.songState) : null;
        }

        if (!loaded?.buffer) {
            disableJukeboxWithSeamlessError(
                jukebox,
                announceFailure
                    ? "No decoded audio loaded for this track; jukebox disabled."
                    : "Seamless audio unavailable; jukebox disabled."
            );
            return false;
        }

        if (state.activeDriver?.songState === jukebox.songState) {
            return true;
        }

        const originalDriver = jukebox.driver;
        originalDriver?.stop?.();

        const driver = new SeamlessWebAudioDriver(jukebox, originalDriver, loaded.buffer);
        jukebox.driver = driver;
        state.activeDriver = driver;
        await driver.start();
        notify(`Seamless Web Audio active: ${loaded.label}`);
        return true;
    }

    function patchGetProgressApi() {
        const playerApi = Spicetify?.Platform?.PlayerAPI;

        if (playerApi && !state.originalGetProgress && typeof playerApi.getProgress === "function") {
            state.originalGetProgress = playerApi.getProgress.bind(playerApi);
            playerApi.getProgress = function seamlessAwareApiGetProgress(...args) {
                if (state.activeDriver) {
                    return state.activeDriver.getProgress();
                }

                return state.originalGetProgress(...args);
            };
        }

        const player = Spicetify?.Player;

        if (player && !state.originalPlayerGetProgress && typeof player.getProgress === "function") {
            state.originalPlayerGetProgress = player.getProgress.bind(player);
            player.getProgress = function seamlessAwarePlayerGetProgress(...args) {
                if (state.activeDriver) {
                    return state.activeDriver.getProgress();
                }

                return state.originalPlayerGetProgress(...args);
            };
        }
    }

    function patchTransportMethod(target, originalKey, method, handler) {
        if (!target || state[originalKey] || typeof target[method] !== "function") {
            return;
        }

        state[originalKey] = target[method].bind(target);
        target[method] = function seamlessAwareTransportMethod(...args) {
            if (!state.suppressTransportPatch && state.activeDriver) {
                const result = handler(state.activeDriver, args);
                result?.catch?.(console.error);
                return Promise.resolve();
            }

            return state[originalKey](...args);
        };
    }

    function isTrackChangingPlay(args) {
        return args.some((arg) => {
            if (!arg) {
                return false;
            }

            if (typeof arg === "string") {
                return arg.startsWith("spotify:");
            }

            return Boolean(arg.uri || arg.uris || arg.context || arg.context_uri || arg.contextUri);
        });
    }

    function patchTransportApi() {
        const playerApi = Spicetify?.Platform?.PlayerAPI;
        const player = Spicetify?.Player;

        patchTransportMethod(playerApi, "originalPause", "pause", (driver) => driver.pause());
        patchTransportMethod(player, "originalPlayerPause", "pause", (driver) => driver.pause());
        patchTransportMethod(playerApi, "originalResume", "resume", (driver) => driver.resume());
        patchTransportMethod(player, "originalPlayerResume", "resume", (driver) => driver.resume());
        patchTransportMethod(playerApi, "originalTogglePlay", "togglePlay", (driver) => driver.togglePause());
        patchTransportMethod(player, "originalPlayerTogglePlay", "togglePlay", (driver) => driver.togglePause());
        patchTransportMethod(playerApi, "originalPlay", "play", (driver, args) => {
            if (isTrackChangingPlay(args)) {
                state.activeDriver?.stop?.();
                return state.originalPlay(...args);
            }

            return driver.resume();
        });
        patchTransportMethod(player, "originalPlayerPlay", "play", (driver, args) => {
            if (isTrackChangingPlay(args)) {
                state.activeDriver?.stop?.();
                return state.originalPlayerPlay(...args);
            }

            return driver.resume();
        });
    }

    function patchTransportEvents() {
        if (state.transportEventsPatched) {
            return;
        }

        state.transportEventsPatched = true;
        document.addEventListener("click", (event) => {
            const driver = state.activeDriver;

            if (!driver) {
                return;
            }

            const button = event.target?.closest?.(
                'button[data-testid="control-button-playpause"], button.main-playPauseButton-button, button[aria-label="Pause"], button[aria-label="Play"]'
            );

            if (!button || !isInTransportArea(button)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            driver.togglePause().catch(console.error);
        }, true);

        document.addEventListener("keydown", (event) => {
            const driver = state.activeDriver;

            if (!driver || isEditableTarget(event.target)) {
                return;
            }

            if (event.code !== "Space" && event.key !== "MediaPlayPause") {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            driver.togglePause().catch(console.error);
        }, true);
    }

    function patchSeekApi() {
        const playerApi = Spicetify?.Platform?.PlayerAPI;

        if (playerApi && !state.originalSeekTo && typeof playerApi.seekTo === "function") {
            state.originalSeekTo = playerApi.seekTo.bind(playerApi);
            playerApi.seekTo = function seamlessAwareSeek(positionMs, ...args) {
                if (state.activeDriver) {
                    state.activeDriver.seekTo(positionMs);
                    return Promise.resolve();
                }

                return state.originalSeekTo(positionMs, ...args);
            };
        }

        const player = Spicetify?.Player;

        if (player && !state.originalPlayerSeek && typeof player.seek === "function") {
            state.originalPlayerSeek = player.seek.bind(player);
            player.seek = function seamlessAwarePlayerSeek(positionMs, ...args) {
                if (state.activeDriver) {
                    state.activeDriver.seekTo(positionMs);
                    return Promise.resolve();
                }

                return state.originalPlayerSeek(positionMs, ...args);
            };
        }
    }

    function patchJukebox(jukebox) {
        if (!jukebox || jukebox[PATCH_FLAG]) {
            return Boolean(jukebox);
        }

        Object.defineProperty(jukebox, PATCH_FLAG, { value: true });
        const originalStart = jukebox.start.bind(jukebox);
        const originalStop = jukebox.stop.bind(jukebox);

        jukebox.start = async function startWithSeamlessAudio(...args) {
            if (!await isHelperRunning()) {
                disableJukeboxWithSeamlessError(this, "Seamless helper is not running; jukebox disabled.");
                return;
            }

            const result = await originalStart(...args);
            await switchToSeamless(this, false);
            return result;
        };

        jukebox.stop = function stopWithSeamlessAudio(...args) {
            state.activeDriver?.stop?.();
            return originalStop(...args);
        };

        switchToSeamless(jukebox, false);
        return true;
    }

    state.switchToSeamless = () => switchToSeamless(window.jukebox, true);

    const waitForInstall = window.setInterval(() => {
        patchSeekApi();
        patchGetProgressApi();
        patchTransportApi();
        patchTransportEvents();
        document.getElementById("ejb-seamless-audio-button")?.remove();

        if (patchJukebox(window.jukebox)) {
            window.clearInterval(waitForInstall);
        }
    }, 250);
})();

