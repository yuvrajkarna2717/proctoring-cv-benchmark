import Card from "react-bootstrap/Card";
import Table from "react-bootstrap/Table";
import { formatBytes, formatClock, formatInteger, formatNumber } from "../common/format.js";

/**
 * Preview and main-thread health: is the camera preview keeping its frame rate and is the main
 * thread responsive while engines run? Plus the latest memory measurement.
 *
 * @param {{ snapshot: ReturnType<import('../../app/LabController.js').LabController['buildSnapshot']> }} props
 */
export function RuntimeHealthPanel({ snapshot }) {
  const source = snapshot.camera.frameSource;
  const { mainThread, memory } = snapshot.monitor;
  const { stalls, pageEvents } = mainThread;
  const lag = mainThread.eventLoopLagMs;
  const frameRate = source?.frameIntervalMs ? 1000 / source.frameIntervalMs : null;
  const lastStall = stalls.recent.findLast((stall) => !stall.pageHiddenDuringGap) ?? null;

  return (
    <Card className="mb-3">
      <Card.Header className="py-2">Preview and main thread</Card.Header>
      <Card.Body className="p-0">
        <Table size="sm" className="metric-table mb-0" data-testid="runtime-health">
          <tbody>
            <tr>
              <th title="A stall is a period without frame callbacks while the video plays (main thread busy, or page hidden); a timer delivers frame ticks until callbacks resume">
                Frame clock
              </th>
              <td>
                {source?.clock ?? "—"}
                {source && source.stalls > 0
                  ? ` (${source.stalls} stall${source.stalls === 1 ? "" : "s"}, ${source.fallbackTicks} fallback ticks)`
                  : ""}
              </td>
              <th>Frame tick rate</th>
              <td>{formatNumber(frameRate, 1)} fps</td>
            </tr>
            <tr>
              <th title="Frames composited without a frame callback. In Chromium this means the main thread was busy; Firefox also skips callbacks on its own (Mozilla bug 1935256).">
                Missed frame callbacks
              </th>
              <td>{formatInteger(source?.missedCallbacks)}</td>
              <th title="HTMLVideoElement.getVideoPlaybackQuality(). Firefox does not count frames of camera streams.">
                Dropped / total video frames
              </th>
              <td>
                {!source && "—"}
                {source &&
                  (source.playbackQuality
                    ? `${source.playbackQuality.droppedVideoFrames} / ${source.playbackQuality.totalVideoFrames}`
                    : "not reported by this browser")}
              </td>
            </tr>
            <tr>
              <th
                title={`Lateness of a ${mainThread.eventLoopProbeIntervalMs} ms timer while the page is visible. Samples taken while the page was hidden are excluded because browsers throttle timers then.`}
              >
                Event-loop lag p95 / max
              </th>
              <td>
                {formatNumber(lag.p95, 1)} / {formatNumber(lag.max, 1)} ms (n={lag.count})
                {mainThread.hiddenSamplesExcluded > 0 &&
                  ` · ${mainThread.hiddenSamplesExcluded} hidden-page samples excluded`}
              </td>
              <th>Long tasks (≥ 50 ms)</th>
              <td>
                {mainThread.longTasks.supported
                  ? `${mainThread.longTasks.count} · total ${formatNumber(mainThread.longTasks.totalMs, 0)} ms · max ${formatNumber(mainThread.longTasks.maxMs, 0)} ms`
                  : "not supported"}
              </td>
            </tr>
            <tr>
              <th
                title={`The ${mainThread.eventLoopProbeIntervalMs} ms timer fired at least ${mainThread.stallThresholdMs} ms late while the page was visible. Each stall is logged with its time; the exported report lists the latest ones.`}
              >
                Main-thread stalls (≥ {mainThread.stallThresholdMs} ms)
              </th>
              <td data-testid="main-thread-stalls">
                {stalls.count === 0
                  ? "none"
                  : `${stalls.count} · max ${formatNumber(stalls.maxMs, 0)} ms`}
                {lastStall &&
                  ` · last at ${formatClock(lastStall.endedAt)} (${formatNumber(lastStall.durationMs, 0)} ms${lastStall.windowBlurredDuringGap ? ", window not focused" : ""})`}
                {stalls.hiddenPageGaps > 0 &&
                  ` · ${stalls.hiddenPageGaps} late timer${stalls.hiddenPageGaps === 1 ? "" : "s"} while hidden (not counted)`}
              </td>
              <th title="Page visibility and window focus changes since the last metrics reset">
                Page hidden / focus lost
              </th>
              <td>
                {pageEvents.counts.hidden}× / {pageEvents.counts.blur}×
              </td>
            </tr>
            <tr>
              <th>Memory</th>
              <td colSpan={3}>
                {!memory && "Not measured yet"}
                {memory?.method === "measureUserAgentSpecificMemory" && (
                  <>
                    {formatBytes(memory.totalBytes)} total at {formatClock(memory.measuredAt)} (took{" "}
                    {formatNumber(memory.durationMs, 0)} ms) ·{" "}
                    {memory.contexts
                      .slice(0, 6)
                      .map(
                        (context) =>
                          `${context.scope}${context.shared ? " (shared)" : ""} ${shortUrl(context.url)}: ${formatBytes(context.bytes)}`,
                      )
                      .join(" · ")}
                  </>
                )}
                {memory?.method === "performance.memory" && (
                  <>
                    JS heap {formatBytes(memory.usedJSHeapSize)} used ({memory.note})
                  </>
                )}
                {memory?.method === "unavailable" && memory.note}
              </td>
            </tr>
          </tbody>
        </Table>
      </Card.Body>
    </Card>
  );
}

/** @param {string} url */
function shortUrl(url) {
  if (!url) return "";
  const path = url.split("?")[0];
  return path.slice(path.lastIndexOf("/") + 1) || path;
}
