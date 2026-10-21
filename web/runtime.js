export function formatElapsed(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const pad = n => String(n).padStart(2, "0");
    return seconds >= 3600 ? `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}` :
        `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

// Server elapsed time is anchored to the browser's monotonic clock, so changes
// to the local wall clock cannot reset a running timer. Never infer progress.
export function createRuntimeStatus({ identity, fetchStatus, onChange, onSnapshot,
    now = () => performance.now(), every = setInterval, cancel = clearInterval }) {
    let record = null, receivedAt = 0, elapsed = 0, timer = null, disconnected = false;
    let controller = null, epoch = 0, disposed = false;
    const active = () => record?.timing.state === "running";
    const elapsedNow = () => elapsed + (active() ? Math.max(0, now() - receivedAt) : 0);
    const stop = () => { if (timer != null) cancel(timer); timer = null; };
    const matches = detail => ["task_family", "workflow_id", "node_id", "node_key"].every(key => String(detail[key] ?? "") === String(identity()[key] ?? ""));
    function accept(detail) {
        const timing = detail?.timing;
        if (disposed || !timing || !matches(detail) || !timing.run_id ||
            !Number.isFinite(timing.started_at) || !Number.isFinite(timing.elapsed_ms) || timing.elapsed_ms < 0 ||
            !Number.isInteger(timing.revision) || !["running", "completed", "failed", "interrupted"].includes(timing.state)) return false;
        const previous = record?.timing;
        if (previous && (timing.started_at < previous.started_at ||
            (timing.run_id === previous.run_id && (timing.revision < previous.revision || (previous.state !== "running" && timing.state === "running"))))) return false;
        const sameRun = timing.run_id === previous?.run_id;
        // A refresh snapshot may share a revision with the last WebSocket
        // event but have a newer elapsed value. Terminal time stays exact.
        elapsed = timing.state === "running" && sameRun ? Math.max(timing.elapsed_ms, elapsedNow()) : timing.elapsed_ms;
        receivedAt = now(); record = detail; disconnected = false;
        if (active() && timer == null) timer = every(() => onChange(), 1000);
        if (!active()) stop();
        onChange();
        return true;
    }
    async function restore() {
        controller?.abort();
        const current = ++epoch;
        const scope = JSON.stringify(identity());
        if (record && !matches(record)) { record = null; stop(); onChange(); }
        controller = new AbortController();
        try {
            const detail = await fetchStatus(identity(), controller.signal);
            if (disposed || current !== epoch || scope !== JSON.stringify(identity())) return;
            if (detail) { if (onSnapshot) onSnapshot(detail); else accept(detail); }
            // A reachable server without this run (e.g. backend restarted)
            // must not leave a stale browser timer counting forever.
            else if (active()) {
                elapsed = elapsedNow(); receivedAt = now();
                record = { ...record, message: "当前服务已无运行记录，请到平台任务记录查看结果", timing: { ...record.timing, state: "interrupted" } };
                stop(); onChange();
            }
        } catch (error) {
            if (error.name !== "AbortError" && current === epoch && !disposed && active()) { disconnected = true; onChange(); }
        }
    }
    return {
        accept, restore,
        line(fallback) {
            if (!record) return fallback;
            const message = active() && disconnected ? "连接已断开，正在重连" : record.message;
            return `${message} · ${active() ? "已等待" : "总用时"} ${formatElapsed(elapsedNow())}`;
        },
        setConnected(connected) { disconnected = !connected; if (active()) onChange(); },
        dispose() { disposed = true; ++epoch; controller?.abort(); stop(); },
    };
}
