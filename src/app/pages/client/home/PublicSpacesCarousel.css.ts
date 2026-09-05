import { globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { DefaultReset, color, config, toRem } from 'folds';

export const CarouselGradient = recipe({
  base: [
    DefaultReset,
    {
      position: 'absolute',
      height: '100%',
      width: toRem(12),
      zIndex: 1,
    },
  ],
  variants: {
    position: {
      Left: {
        left: 0,
        background: `linear-gradient(to right, ${color.Background.Container} , rgba(116,116,116,0))`,
      },
      Right: {
        right: 0,
        background: `linear-gradient(to left, ${color.Background.Container} , rgba(116,116,116,0))`,
      },
    },
  },
});

export const CarouselBtn = recipe({
  base: [
    DefaultReset,
    {
      position: 'absolute',
      zIndex: 1,
    },
  ],
  variants: {
    position: {
      Left: {
        left: 0,
        transform: 'translateX(-25%)',
      },
      Right: {
        right: 0,
        transform: 'translateX(25%)',
      },
    },
  },
});

export const CarouselPanel = style({
  width: toRem(260),
  maxWidth: toRem(260),
  minWidth: toRem(260),
  flex: `0 0 ${toRem(260)}`,
});

// Card content (below the banner) with padding matching the shared RoomCard.
export const CarouselCardItems = style({
  padding: config.space.S500,
  backgroundColor: color.SurfaceVariant.Container,
});

// Banner image: fills the fixed-height header without stretching.
export const CarouselCardBanner = style({
  width: '100%',
  height: '100%',
  minHeight: toRem(96),
  objectFit: 'cover',
  objectPosition: 'center center',
});

// Colored fallback block used when a space has no avatar/banner.
export const CarouselCardFallback = style({
  width: '100%',
  height: '100%',
  minHeight: toRem(96),
});

// Overlapping avatar pinned to the bottom-left of the banner.
export const CarouselCardAvatar = style({
  position: 'sticky',
  transform: 'translateY(-50%)',
  marginLeft: config.space.S500,
  outline: `${config.borderWidth.B600} solid ${color.Surface.Container}`,
});

// Keep the inner RoomCard filling its panel so content-driven banner sizes
// can't make one card narrower than the others.
globalStyle(`${CarouselPanel} > *`, {
  width: '100%',
  minWidth: 0,
});
