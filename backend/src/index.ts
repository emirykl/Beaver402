import { createApp } from "./app.js";

const app = createApp();

// A serverless host imports the app and routes requests to it itself. Run
// directly, it listens like any server.
if (!process.env.VERCEL) {
  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, () => {
    console.log(`beaver402 backend running on port ${port}`);
  });
}

export default app;
