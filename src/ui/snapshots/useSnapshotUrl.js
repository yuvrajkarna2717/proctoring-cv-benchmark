import { useEffect, useState } from "react";
import { useLabController } from "../common/labContext.js";

/**
 * Object URL of a stored snapshot image for an `<img>`, revoked when `id` or `kind` changes or
 * the component unmounts. Null while loading and once the snapshot is gone.
 *
 * @param {string | null} id
 * @param {'image' | 'thumbnail'} kind
 * @returns {string | null}
 */
export function useSnapshotUrl(id, kind) {
  const controller = useLabController();
  const [loaded, setLoaded] = useState(/** @type {{ key: string, url: string } | null} */ (null));
  const key = id ? `${id}:${kind}` : null;

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    /** @type {string | null} */
    let url = null;
    controller.getSnapshotImage(id, kind).then(
      (blob) => {
        if (cancelled || !blob) return;
        url = URL.createObjectURL(blob);
        setLoaded({ key: `${id}:${kind}`, url });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [controller, id, kind]);

  return loaded?.key === key ? loaded.url : null;
}
