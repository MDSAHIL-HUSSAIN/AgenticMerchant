const clone = value => structuredClone(value);

const componentFor = shot => {
  const purpose = String(shot.purpose || "").toLowerCase();
  if (/brand|lockup|final/.test(purpose)) return "BRAND_FINALE";
  if (/hero|full-form/.test(purpose)) return "PRODUCT_HERO";
  if (/feature|impact/.test(purpose)) return "FEATURE_CALLOUT";
  if (/detail|material|construction/.test(purpose)) return "MACRO_INSPECTION";
  if (/hook|mystery/.test(purpose)) return "LIGHT_REVEAL";
  return "PRODUCT_STAGE";
};

const motionCurveFor = shot => {
  const style = String(shot.edit?.style || "LOCKED_LIGHT").toUpperCase();
  const curves = {
    MACRO_PUSH: { scale: [1.02, 1.13], x: [0, -1], y: [1, -1], rotate: [0, 0], easing: "cinematic" },
    LATERAL_SLIDE: { scale: [1.08, 1.08], x: [-5, 5], y: [0, 0], rotate: [0, 0], easing: "smooth" },
    DIAGONAL_DRIFT: { scale: [1.07, 1.13], x: [-3, 4], y: [3, -3], rotate: [-.25, .25], easing: "smooth" },
    HERO_PULLBACK: { scale: [1.13, 1.0], x: [0, 0], y: [1, 0], rotate: [0, 0], easing: "cinematic" },
    ENERGY_PULSE: { scale: [1.04, 1.11], x: [-1, 1], y: [0, -1], rotate: [0, 0], easing: "spring" },
    PRECISION_TRACK: { scale: [1.1, 1.1], x: [5, -5], y: [0, 0], rotate: [0, 0], easing: "linear" },
    LOCKED_LIGHT: { scale: [1.015, 1.035], x: [0, 0], y: [0, 0], rotate: [0, 0], easing: "smooth" }
  };
  return curves[style] || curves.LOCKED_LIGHT;
};

export function withEditableTimeline(input) {
  const plan = clone(input);
  let cursor = 0;
  plan.schemaVersion = 2;
  plan.editor = {
    engine: "remotion",
    editable: true,
    previewScale: .5,
    maximumVisualRepairPasses: 3,
    ...(plan.editor || {})
  };
  plan.shots = plan.shots.map((shot, index) => {
    const startSeconds = cursor;
    cursor += Number(shot.durationSeconds || 0);
    const duration = Number(shot.durationSeconds || 0);
    return {
      ...shot,
      editor: {
        ...(shot.editor || {}),
        component: shot.editor?.component || componentFor(shot),
        sourceStrategy: shot.renderMode === "GENERATIVE" ? "GENERATED_CLIP" : "PRODUCT_PLATE",
        startSeconds,
        endSeconds: cursor,
        motionCurve: shot.editor?.motionCurve || motionCurveFor(shot),
        layers: ["ATMOSPHERE", "SOURCE", "LIGHT", "TYPOGRAPHY", "GRAIN"],
        typography: {
          entrance: index === 0 ? "FADE_RISE" : index % 2 ? "MASK_REVEAL" : "TRACK_IN",
          exit: index === plan.shots.length - 1 ? "HOLD" : "FADE",
          safeArea: .08,
          scale: 1,
          scrimOpacity: .54,
          ...(shot.editor?.typography || {})
        },
        inspectionMoments: [
          Number((startSeconds + Math.min(.12, duration * .08)).toFixed(3)),
          Number((startSeconds + duration * .5).toFixed(3)),
          Number((Math.max(startSeconds, cursor - Math.min(.12, duration * .08))).toFixed(3))
        ],
        continuityFrom: index ? plan.shots[index - 1]?.id : null,
        continuityTo: index < plan.shots.length - 1 ? plan.shots[index + 1]?.id : null
      }
    };
  });
  plan.timeline = {
    durationSeconds: plan.durationSeconds,
    fps: plan.fps,
    shotCount: plan.shots.length,
    cutPoints: plan.shots.slice(0, -1).map(shot => shot.editor.endSeconds),
    inspectionMoments: [...new Set(plan.shots.flatMap(shot => shot.editor.inspectionMoments))].sort((a, b) => a - b)
  };
  return plan;
}

function shotForIssue(plan, issue) {
  return plan.shots.find(shot => shot.id === issue.shotId)
    || plan.shots[Math.max(0, Math.min(plan.shots.length - 1, Number(issue.shotIndex) || 0))];
}

export function applyTargetedVideoRepairs(input, issues = []) {
  const plan = withEditableTimeline(input);
  const actions = [];
  for (const issue of issues.filter(item => item.severity === "high" || item.severity === "medium")) {
    const shot = shotForIssue(plan, issue);
    if (!shot) continue;
    const code = String(issue.code || "").toUpperCase();
    const before = clone({ stage: shot.stage, edit: shot.edit, copy: shot.copy, renderMode: shot.renderMode, seed: shot.seed });
    if (["PRODUCT_TOO_SMALL", "EXCESS_EMPTY_SPACE", "WEAK_PRODUCT_PRESENCE"].includes(code)) {
      shot.stage.productScale = Math.min(1.5, Number(shot.stage.productScale || 1) + .14);
      shot.stage.productX = .5 + (Number(shot.stage.productX || .5) - .5) * .5;
      shot.stage.productY = Math.min(.66, Math.max(.38, Number(shot.stage.productY || .5)));
      shot.focus.zoom = Math.min(3, Number(shot.focus.zoom || 1) + .12);
    } else if (["TEXT_UNREADABLE", "TEXT_COLLISION", "UNSAFE_TEXT"].includes(code)) {
      shot.editor.typography.safeArea = Math.min(.12, Number(shot.editor.typography.safeArea || .08) + .015);
      shot.editor.typography.scale = Math.max(.78, Number(shot.editor.typography.scale || 1) - .08);
      shot.editor.typography.scrimOpacity = Math.min(.82, Number(shot.editor.typography.scrimOpacity || .54) + .14);
      shot.editor.typography.entrance = "FADE_RISE";
    } else if (["WEAK_TRANSITION", "ABRUPT_CUT", "STORY_DISCONTINUITY"].includes(code)) {
      shot.edit.transitionOut = "DISSOLVE";
      shot.edit.transitionDuration = .34;
    } else if (["STATIC_SHOT", "SLIDESHOW_FEEL", "WEAK_MOTION"].includes(code)) {
      shot.edit.style = shot.edit.style === "LATERAL_SLIDE" ? "MACRO_PUSH" : "LATERAL_SLIDE";
      shot.editor.motionCurve = motionCurveFor(shot);
      if (shot.renderMode === "DETERMINISTIC" && !/brand|lockup|final/i.test(shot.purpose)) shot.renderMode = "HYBRID";
    } else if (["PRODUCT_DEFORMATION", "IDENTITY_DRIFT", "FLICKER", "MOTION_GLITCH"].includes(code)) {
      shot.seed = Number(shot.seed || 1) + 104729;
      shot.attempts = Number(shot.attempts || 0) + 1;
      shot.generation.candidates = Math.min(3, Number(shot.generation.candidates || 2) + 1);
    } else if (["BLACK_FRAME", "BLANK_FRAME", "BROKEN_SOURCE"].includes(code)) {
      shot.renderMode = "HYBRID";
      shot.edit.style = "LOCKED_LIGHT";
      shot.edit.transitionOut = "CUT";
      shot.edit.transitionDuration = 0;
    } else {
      continue;
    }
    actions.push({ issue: code, shotId: shot.id, before, after: clone({ stage: shot.stage, edit: shot.edit, copy: shot.copy, renderMode: shot.renderMode, seed: shot.seed }) });
  }
  return { plan: withEditableTimeline(plan), actions, affectedShotIds: [...new Set(actions.map(action => action.shotId))] };
}

export function createTimelineManifest({ jobId, plan, workerReport, keyframes, audioPath, renderPass }) {
  const sources = workerReport?.shotSources || [];
  return {
    schemaVersion: 2,
    jobId,
    renderPass,
    createdAt: new Date().toISOString(),
    durationSeconds: plan.durationSeconds,
    fps: plan.fps,
    palette: plan.palette,
    typography: plan.typography,
    storyArc: plan.storyArc,
    music: plan.music,
    motionSelections: workerReport?.motionSelections || [],
    musicGenerated: Boolean(workerReport?.musicGenerated),
    audioPath,
    shots: plan.shots.map((shot, index) => ({
      ...shot,
      transitionIn: index ? plan.shots[index - 1].edit?.transitionOut || "CUT" : "CUT",
      source: sources[index] || { path: null, type: "image", generatedDuration: shot.durationSeconds },
      keyframeAssetId: keyframes[index]?.assetId,
      overlayAssetId: keyframes[index]?.overlayAssetId
    }))
  };
}
