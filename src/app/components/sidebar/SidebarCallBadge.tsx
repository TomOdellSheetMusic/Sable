import { Box, Badge, config } from 'folds';
import { sizedIcon, Phone } from '$components/icons/phosphor';
import { SidebarItemBadge } from './SidebarItem';

/**
 * A live-call indicator for sidebar space items. Shown when any room inside
 * the space currently has an active MatrixRTC session (people in a call).
 * Rendered in the corner opposite the unread badge so the two never collide.
 */
export function SidebarCallBadge() {
  return (
    <SidebarItemBadge mode="call">
      <Badge variant="Success" fill="Solid" size="300" radii="Pill">
        <Box
          alignItems="Center"
          justifyContent="Center"
          style={{ width: config.space.S300, height: config.space.S300 }}
        >
          {sizedIcon(Phone, '100', { weight: 'fill' })}
        </Box>
      </Badge>
    </SidebarItemBadge>
  );
}
