import React from "react";
import { AbsoluteFill, Audio, Composition, Easing, Img, Sequence, Video, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

const pct = value => `${value}%`;

function Atmosphere({ shot, palette }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = Math.min(1, frame / Math.max(1, durationInFrames - 1));
  const accent = palette?.[2] || "#6EB8FF";
  const drift = interpolate(progress, [0, 1], [-8, 8]);
  const component = shot.editor?.component;
  return <AbsoluteFill style={{ overflow: "hidden", background: palette?.[0] || "#050505" }}>
    <AbsoluteFill style={{ background: `radial-gradient(circle at ${50 + drift}% 42%, ${accent}55 0%, transparent 46%), linear-gradient(150deg, ${palette?.[0] || "#050505"}, #020208)` }} />
    {component === "MACRO_INSPECTION" ? <AbsoluteFill style={{ opacity: .16, backgroundImage: `repeating-linear-gradient(115deg, transparent 0 38px, ${accent} 40px, transparent 42px)` }} /> : null}
    {component === "LIGHT_REVEAL" ? <div style={{ position: "absolute", left: pct(15 + progress * 65), top: "-10%", width: "8%", height: "120%", filter: "blur(28px)", transform: "rotate(14deg)", background: `linear-gradient(90deg, transparent, ${accent}99, transparent)` }} /> : null}
    {component === "PRODUCT_HERO" ? <div style={{ position: "absolute", inset: "12% -20%", border: `2px solid ${accent}30`, borderRadius: "50%", transform: `scale(${.82 + progress * .18})`, boxShadow: `0 0 90px ${accent}33` }} /> : null}
  </AbsoluteFill>;
}

function SourceLayer({ shot }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const progress = Math.min(1, frame / Math.max(1, durationInFrames - 1));
  const curve = shot.editor?.motionCurve || { scale: [1, 1.03], x: [0, 0], y: [0, 0], rotate: [0, 0] };
  const ease = curve.easing === "linear" ? Easing.linear : Easing.inOut(Easing.cubic);
  const move = (values, fallback) => interpolate(progress, [0, 1], values || fallback, { easing: ease });
  const style = {
    width: "100%", height: "100%", objectFit: "cover",
    transform: `translate(${move(curve.x, [0, 0])}%, ${move(curve.y, [0, 0])}%) scale(${move(curve.scale, [1, 1.03])}) rotate(${move(curve.rotate, [0, 0])}deg)`,
    filter: `saturate(${1.02 + Math.sin(progress * Math.PI) * .04}) contrast(1.025)`
  };
  if (shot.source?.type === "video") {
    const playbackRate = Math.max(.2, Math.min(4, Number(shot.source.generatedDuration || shot.durationSeconds) / Number(shot.durationSeconds)));
    return <Video src={staticFile(shot.source.publicName)} style={style} playbackRate={playbackRate} volume={0} loop />;
  }
  return <Img src={staticFile(shot.source.publicName)} style={style} />;
}

function Typography({ shot, palette }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = Math.min(1, frame / Math.max(1, fps * .45));
  const exit = shot.editor?.typography?.exit === "HOLD" ? 1 : Math.min(1, (durationInFrames - frame) / Math.max(1, fps * .3));
  const opacity = Math.min(enter, exit);
  const rise = interpolate(enter, [0, 1], [36, 0], { easing: Easing.out(Easing.cubic) });
  const copy = shot.copy || {};
  const settings = shot.editor?.typography || {};
  const safe = `${Math.max(5, Math.min(15, Number(settings.safeArea || .08) * 100))}%`;
  const typeScale = Math.max(.72, Math.min(1.1, Number(settings.scale || 1)));
  if (!copy.eyebrow && !copy.headline && !copy.subheadline) return null;
  return <div style={{ position: "absolute", left: safe, right: safe, bottom: safe, color: palette?.[1] || "#fff", opacity, transform: `translateY(${rise}px)`, textShadow: "0 2px 24px #000", padding: "34px 28px", margin: "-34px -28px", background: `linear-gradient(90deg, rgba(0,0,0,${Number(settings.scrimOpacity || .54)}), transparent)` }}>
    {copy.eyebrow ? <div style={{ color: palette?.[2] || "#7ac7ff", fontFamily: "Arial, sans-serif", fontSize: 22 * typeScale, fontWeight: 700, letterSpacing: 7 * typeScale, marginBottom: 18, textTransform: "uppercase" }}>{copy.eyebrow}</div> : null}
    {copy.headline ? <div style={{ fontFamily: "Georgia, serif", fontSize: (copy.headline.length > 32 ? 54 : 68) * typeScale, lineHeight: 1.02, maxWidth: "92%" }}>{copy.headline}</div> : null}
    {copy.subheadline ? <div style={{ fontFamily: "Arial, sans-serif", fontSize: 27 * typeScale, lineHeight: 1.25, opacity: .78, marginTop: 16 }}>{copy.subheadline}</div> : null}
  </div>;
}

function Shot({ shot, palette }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const transitionFrames = Math.max(1, Math.round(Number(shot.edit?.transitionDuration || .18) * fps));
  const fadeIn = interpolate(frame, [0, transitionFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = shot.edit?.transitionOut === "CUT" ? 1 : interpolate(frame, [durationInFrames - transitionFrames, durationInFrames - 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const transition = String(shot.transitionIn || "CUT").toUpperCase();
  const entrance = Math.min(1, frame / transitionFrames);
  const entranceStyle = transition.includes("LEFT")
    ? { transform: `translateX(${(1 - entrance) * 100}%)` }
    : transition.includes("UP")
      ? { transform: `translateY(${(1 - entrance) * 100}%)` }
      : transition === "CIRCLE_OPEN"
        ? { clipPath: `circle(${entrance * 75}% at 50% 50%)` }
        : transition === "RADIAL"
          ? { transform: `scale(${.72 + entrance * .28}) rotate(${(1 - entrance) * 5}deg)` }
          : transition === "PIXELIZE"
            ? { filter: `blur(${(1 - entrance) * 18}px)`, transform: `scale(${1.08 - entrance * .08})` }
            : {};
  const incomingOpacity = transition === "CUT" || transition.includes("WIPE") || transition.includes("SLIDE") || transition === "CIRCLE_OPEN" ? 1 : fadeIn;
  const sweep = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [-45, 145]);
  return <AbsoluteFill style={{ opacity: Math.min(incomingOpacity, fadeOut), background: "#000", ...entranceStyle }}>
    <Atmosphere shot={shot} palette={palette} />
    <SourceLayer shot={shot} />
    <div style={{ position: "absolute", top: "-20%", bottom: "-20%", left: `${sweep}%`, width: "18%", transform: "rotate(12deg)", filter: "blur(34px)", opacity: shot.editor?.component === "BRAND_FINALE" ? .08 : .18, background: `linear-gradient(90deg, transparent, ${palette?.[2] || "#6EB8FF"}88, transparent)`, mixBlendMode: "screen" }} />
    <AbsoluteFill style={{ background: "linear-gradient(180deg, transparent 45%, rgba(0,0,0,.54) 100%)", mixBlendMode: "multiply" }} />
    <Typography shot={shot} palette={palette} />
    <AbsoluteFill style={{ pointerEvents: "none", opacity: .055, backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E\")" }} />
  </AbsoluteFill>;
}

function Film({ manifest }) {
  const { fps } = useVideoConfig();
  return <AbsoluteFill style={{ background: "#000" }}>
    {manifest.shots.map(shot => <Sequence key={shot.id} from={Math.round(shot.editor.startSeconds * fps)} durationInFrames={Math.max(1, Math.round(shot.durationSeconds * fps))} premountFor={fps}>
      <Shot shot={shot} palette={manifest.palette} />
    </Sequence>)}
    {manifest.audioPublicName ? <Audio src={staticFile(manifest.audioPublicName)} /> : null}
  </AbsoluteFill>;
}

export function VideoProject() {
  return <Composition id="ProductFilm" component={Film} defaultProps={{ manifest: { durationSeconds: 15, fps: 30, width: 540, height: 960, shots: [] } }} durationInFrames={450} fps={30} width={540} height={960} calculateMetadata={({ props }) => ({ durationInFrames: Math.max(1, Math.round(props.manifest.durationSeconds * props.manifest.fps)), fps: props.manifest.fps, width: props.manifest.width, height: props.manifest.height })} />;
}
