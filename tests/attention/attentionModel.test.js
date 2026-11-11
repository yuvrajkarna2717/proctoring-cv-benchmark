import { describe, expect, it } from "vitest";
import {
  AttentionClassifier,
  BaselineLearner,
  boxExcess,
  gazeLimits,
  readAttentionFrame,
} from "../../src/attention/attentionModel.js";
import { attentionConfig, attentionResult, frame, profile } from "../helpers/attention.js";

describe("readAttentionFrame", () => {
  it("reads head pose, gaze, and eye state of the primary face", () => {
    const result = attentionResult(frame({ at: 5, gazeYaw: 3, headYaw: 2, blink: 0.4 }));
    expect(readAttentionFrame(result)).toEqual({
      at: 5,
      faceCount: 1,
      head: { yawDeg: 2, pitchDeg: -5, rollDeg: 0 },
      gaze: { yawDeg: 3, pitchDeg: -10, eyeWidthPx: 30 },
      eyes: { blinkLeft: 0.4, blinkRight: 0.4, earLeft: 0.3, earRight: 0.3 },
    });
  });

  it("returns no measurements for a frame without faces, and null without FACE_COUNT", () => {
    expect(readAttentionFrame(attentionResult(frame({ faceCount: 0 })))).toMatchObject({
      faceCount: 0,
      head: null,
      gaze: null,
    });
    expect(readAttentionFrame({ frameCaptureTime: 0, observations: [] })).toBeNull();
  });

  it("treats an undetected gaze observation as missing", () => {
    expect(readAttentionFrame(attentionResult(frame({ noGaze: true }))).gaze).toBeNull();
  });
});

describe("boxExcess and gazeLimits", () => {
  const box = { leftDeg: 20, rightDeg: 20, upDeg: 10, downDeg: 15 };

  it("is negative inside (distance to the nearest edge) and positive outside, with the side", () => {
    expect(boxExcess(0, 0, box)).toEqual({ excessDeg: -10, direction: "up" });
    expect(boxExcess(25, 0, box)).toEqual({ excessDeg: 5, direction: "right" });
    expect(boxExcess(-22, 0, box)).toEqual({ excessDeg: 2, direction: "left" });
    expect(boxExcess(0, -18, box)).toEqual({ excessDeg: 3, direction: "down" });
    // Diagonal: the side that is exceeded most.
    expect(boxExcess(23, -19, box)).toEqual({ excessDeg: 4, direction: "down" });
  });

  it("adds the margin on every side and the extra margin below", () => {
    expect(gazeLimits(profile(), attentionConfig({ marginDeg: 4, extraDownMarginDeg: 6 }))).toEqual(
      {
        leftDeg: 21,
        rightDeg: 21,
        upDeg: 14,
        downDeg: 20,
      },
    );
  });
});

describe("AttentionClassifier", () => {
  // Balanced: margin 5, extra down 5, return 2 → tolerated gaze ±22° horizontally, +15° up,
  // −20° down from the centre (0, −10).
  const classify = (frames, config = attentionConfig(), p = profile()) => {
    const classifier = new AttentionClassifier(config);
    return frames.map((f) => classifier.classify(f, p));
  };

  it("measures gaze relative to the person's screen centre", () => {
    const [sample] = classify([frame({ gazeYaw: 10, gazePitch: -15 })]);
    expect(sample.baseline).toBe("calibration");
    expect(sample.gaze).toMatchObject({ state: "on", yawDeg: 10, pitchDeg: -5 });
    expect(sample.gaze.excessDeg).toBeCloseTo(-12, 6);
  });

  it("reports looking away beyond the margin, with the direction and the angle beyond it", () => {
    const [right, down, up] = classify([
      frame({ gazeYaw: 25 }),
      frame({ gazePitch: -33 }),
      frame({ gazePitch: 8 }),
    ]);
    expect(right.gaze).toMatchObject({ state: "away", direction: "right", excessDeg: 3 });
    // Down needs 20° (screen 10 + margin 5 + extra 5): −23 from the centre is 3° beyond.
    expect(down.gaze).toMatchObject({ state: "away", direction: "down", excessDeg: 3 });
    expect(up.gaze).toMatchObject({ state: "away", direction: "up", excessDeg: 3 });
  });

  it("keeps a look away until the gaze is returnMarginDeg back inside (spatial hysteresis)", () => {
    const states = classify([23, 21, 20.5, 19.5, 23].map((gazeYaw) => frame({ gazeYaw }))).map(
      (s) => s.gaze.state,
    );
    // 22° is the edge: 21 and 20.5 stay away (within 2°), 19.5 is back, 23 is away again.
    expect(states).toEqual(["away", "away", "away", "on", "away"]);
  });

  it("is undecided without a face, without a baseline, with closed eyes, or with tiny eyes", () => {
    const classifier = new AttentionClassifier(attentionConfig());
    expect(classifier.classify(frame({ faceCount: 0 }), profile()).gaze).toMatchObject({
      state: "undecided",
      reason: "no face",
    });
    expect(classifier.classify(frame(), null).gaze).toMatchObject({
      state: "undecided",
      reason: "no baseline yet",
    });
    expect(
      classifier.classify(frame({ gazeYaw: 40, blink: 0.9, ear: 0.05 }), profile()).gaze,
    ).toMatchObject({ state: "undecided", reason: "eyes closed" });
    expect(
      classifier.classify(frame({ gazeYaw: 40, eyeWidthPx: 8 }), profile()).gaze,
    ).toMatchObject({ state: "undecided", reason: "eyes too small in the image" });
  });

  it("reports a turned head relative to the baseline head pose", () => {
    const [ok, turned, down] = classify([
      frame({ headYaw: 25 }),
      frame({ headYaw: -33 }),
      frame({ headPitch: -32 }),
    ]);
    expect(ok.head).toMatchObject({ state: "ok", yawDeg: 25 });
    expect(turned.head).toMatchObject({ state: "turned", direction: "left", excessDeg: 3 });
    // Baseline pitch −5; −32 is 27° down, the limit is 25°.
    expect(down.head).toMatchObject({ state: "turned", direction: "down", excessDeg: 2 });
  });

  it("needs both a high blink score and a low eye aspect ratio for closed eyes", () => {
    const [closed, narrowEyes, lowScore] = classify([
      frame({ blink: 0.8, ear: 0.1 }),
      // Naturally narrow eyes: high blink score, but the aspect ratio is near the person's own
      // open value (profile openEar 0.3).
      frame({ blink: 0.8, ear: 0.27 }),
      frame({ blink: 0.3, ear: 0.1 }),
    ]);
    expect(closed.eyes).toMatchObject({ state: "closed", closure: 0.8 });
    expect(closed.eyes.earRatio).toBeCloseTo(0.333, 3);
    expect(narrowEyes.eyes.state).toBe("open");
    expect(lowScore.eyes.state).toBe("open");
  });

  it("leaves the eye state undecided while the head is lowered (lids drop when looking down)", () => {
    // Baseline head pitch −5; −30 is 25° down, beyond undecidedHeadDownDeg (20).
    const [sample] = classify([frame({ headPitch: -30, blink: 0.8, ear: 0.1 })]);
    expect(sample.eyes).toMatchObject({ state: "undecided", reason: "head lowered" });
  });

  it("follows tolerance changes", () => {
    const classifier = new AttentionClassifier(attentionConfig());
    expect(classifier.classify(frame({ gazeYaw: 20 }), profile()).gaze.state).toBe("on");
    classifier.setConfig(attentionConfig({ marginDeg: 1 }));
    classifier.reset();
    expect(classifier.classify(frame({ gazeYaw: 20 }), profile()).gaze.state).toBe("away");
  });
});

describe("BaselineLearner", () => {
  it("learns the median gaze and head pose after learnMs and minSamples, with the default screen", () => {
    const config = attentionConfig({ baseline: { learnMs: 1000, minSamples: 5 } });
    const learner = new BaselineLearner(config);
    const results = [];
    // Five frames at the screen, one look away; the median ignores the look away.
    const yaws = [2, 3, 40, 2, 4, 3, 3];
    yaws.forEach((gazeYaw, index) => {
      results.push(learner.observe(frame({ at: index * 200, gazeYaw, headYaw: 1, ear: 0.32 })));
    });
    expect(results.slice(0, 5)).toEqual([null, null, null, null, null]);
    const learned = results.find(Boolean);
    expect(learned).toMatchObject({
      source: "learned",
      gazeCenter: { yawDeg: 3, pitchDeg: -10 },
      headCenter: { yawDeg: 1, pitchDeg: -5 },
      screen: config.defaultScreen,
      openEar: 0.32,
    });
  });

  it("does not learn from frames with closed eyes, several faces, or no gaze", () => {
    const learner = new BaselineLearner(
      attentionConfig({ baseline: { learnMs: 0, minSamples: 1 } }),
    );
    expect(learner.observe(frame({ blink: 0.9 }))).toBeNull();
    expect(learner.observe(frame({ faceCount: 2 }))).toBeNull();
    expect(learner.observe(frame({ noGaze: true }))).toBeNull();
    expect(learner.progress.samples).toBe(0);
    expect(learner.observe(frame())).toMatchObject({ source: "learned", samples: 1 });
  });
});
