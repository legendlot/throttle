// The camera engine now lives in @throttle/ui (packages/ui/camera.mjs) so Depot can scan with it too; this keeps
// Outpost's imports (Camera.js, CamTest.js, test/camera.test.mjs) unchanged.
export * from '@throttle/ui/camera.mjs';
