# Artifact Sidebar Host

Static Host service for Artifact Sidebar durable state and bounded artifact previews.

## Config

`allowedRoots` and `allowedUrlOrigins` are explicit source policies. `maxPreviewChars`, `maxPins`, `maxSourceLabelBytes`, `maxPinNoteBytes`, `maxDraftBytes`, and `maxSubmissionBytes` are required positive safe-integer bounds. Local paths are checked against configured real roots on every operation; HTTP(S) sources must use a configured origin.

## Model Experience

Artifact Sidebar annotations remain session state. Feedback submission is represented by the ordinary user-message flow, so model history contains the user's selected artifact and bounded notes rather than preview bytes or UI vocabulary.

## Token and KV-cache effect

Only bounded source references, draft text, pin notes, and submission metadata enter session projection state. Preview contents are transient Host responses and are not persisted or added to the model context unless a later consumer submits them. This keeps repeated requests stable for token accounting and KV-cache reuse.

## Known Limitations and Deferred Work

Preview reads support local text/HTML/SVG and configured HTTP(S) origins. Preview content is capped and is never durable. Generic dynamic Cordis package persistence remains out of scope. Exactly-once submission recovery is implemented by the follow-up recovery packet.
