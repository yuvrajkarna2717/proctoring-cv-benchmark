import { useSnapshotUrl } from "./useSnapshotUrl.js";

/**
 * Small preview of a violation snapshot; clicking it opens the snapshot.
 *
 * @param {{ id: string, label: string, onOpen: () => void }} props label: accessible name
 */
export function SnapshotThumb({ id, label, onOpen }) {
  const url = useSnapshotUrl(id, "thumbnail");
  return (
    <button
      type="button"
      className="snapshot-thumb"
      onClick={onOpen}
      aria-label={label}
      title={label}
      data-testid="snapshot-thumb"
    >
      {url && <img src={url} alt="" />}
    </button>
  );
}
