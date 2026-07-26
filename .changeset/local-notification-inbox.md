---
default: minor
---

The notifications inbox is now built from push rules evaluated on this device instead of the server's `/notifications` endpoint, so mentions in encrypted rooms are detected correctly. Notifications can be dismissed individually, the inbox defaults to mentions and DMs, and returning after time away backfills what was missed.
