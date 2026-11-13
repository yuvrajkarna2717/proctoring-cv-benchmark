# Model files

Model binaries are committed so static hosts such as Vercel can serve them. To re-download and hash-verify them:

```powershell
npm run fetch-models
```

The script downloads every file listed in `src/config/modelAssets.js` from its source URL and keeps it only if its size and SHA-256 match the pinned values. Engines check the SHA-256 again when they load a model.

| Directory             | File                   | Source                                                                                                               | License    |
| --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------- |
| `mp-face-landmarker/` | `face_landmarker.task` | `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` (Google) | Apache-2.0 (model cards) |

Intended-use statements and open questions: `docs/MODEL_LICENSES.md`.
