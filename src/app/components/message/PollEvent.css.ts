import { style } from '@vanilla-extract/css';
import { color, config, toRem } from 'folds';

export const PollEvent = style({
  backgroundColor: color.Background.Container,
  maxWidth: toRem(500),
  borderRadius: config.radii.R400,
  padding: config.space.S200,
  paddingTop: config.space.S300,
  border: `${config.borderWidth.B400} solid ${color.SurfaceVariant.ContainerLine}`,
});

export const PollHeader = style({
  color: color.Surface.OnContainer,
  paddingBottom: config.space.S0,
  paddingLeft: config.space.S100,
  paddingRight: config.space.S100,
});

export const PollQuestion = style({
  fontWeight: config.fontWeight.W600,
  color: color.Surface.OnContainer,
});

export const PollEventSeparator = style({
  width: '99%',
  alignSelf: 'Center',
});

export const PollAnswerCount = style({
  color: color.SurfaceVariant.OnContainer,
  paddingLeft: config.space.S100,
  cursor: 'pointer',
});

// These are only here for the potential modding of event by themes
export const PollAnswersBody = style({
  display: 'flex',
  flexDirection: 'column',
  gap: config.space.S200,
  paddingTop: config.space.S0,
});

export const PollAnswerItem = style({
  position: 'relative',
  padding: `${config.space.S200} ${config.space.S300}`,
  borderRadius: config.radii.R500,
  overflow: 'hidden',
  border: `1px solid ${color.SurfaceVariant.ContainerLine}`,
  transition: 'background-color 120ms ease, border-color 120ms ease',
});

export const PollAnswerItemSelected = style({
  borderColor: color.Primary.ContainerLine,
  backgroundColor: `color-mix(in srgb, ${color.Primary.Container} 45%, transparent)`,
});

export const PollAnswerItemClickable = style({
  cursor: 'pointer',
  ':hover': {
    backgroundColor: color.SurfaceVariant.ContainerHover,
  },
});

export const PollAnswerBar = style({
  position: 'absolute',
  inset: 0,
  borderRadius: config.radii.R500,
  pointerEvents: 'none',
  overflow: 'hidden',
  zIndex: 0,
});

export const PollAnswerBarFill = style({
  height: '100%',
  backgroundColor: `color-mix(in srgb, ${color.Primary.Main} 12%, transparent)`,
  transition: 'width 200ms ease',
});

export const PollAnswerBarFillSelected = style({
  backgroundColor: `color-mix(in srgb, ${color.Primary.Main} 32%, transparent)`,
});

export const PollAnswerContent = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: config.space.S100,
  zIndex: 1,
});

export const PollAnswerRow = style({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: config.space.S200,
});

export const PollAnswerText = style({
  flex: 1,
  minWidth: 0,
});

export const PollAnswerPercent = style({
  color: color.SurfaceVariant.OnContainer,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
});

export const PollAnswerPercentSelected = style({
  color: color.Primary.Main,
  fontWeight: config.fontWeight.W600,
});

export const PollAnswerVotedLabel = style({
  color: color.Primary.Main,
  fontWeight: config.fontWeight.W600,
});

export const PollTotal = style({
  color: color.SurfaceVariant.OnContainer,
  fontSize: config.fontSize.T200,
  paddingLeft: config.space.S100,
});
