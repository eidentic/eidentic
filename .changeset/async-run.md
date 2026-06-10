---
"@eidentic/server": minor
---

Add async fire-and-poll run API (`POST /v1/agents/:id/runs` + `GET /v1/agents/:id/runs/:runId/status`). Clients can start a run, disconnect immediately, and poll for completion or replay results via the existing SSE Last-Event-ID path. Auth, rate-limit, and quota checks run before the run is accepted; ownership is enforced on the status endpoint. Also removes ~14 `as unknown as` quota reservation casts by introducing a local `QuotaWithReservation` type alias (depends on `@eidentic/types` `QuotaPort` gaining the `reservation?` param).
