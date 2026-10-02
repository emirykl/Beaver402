// Vercel runs every request through this function. The app itself is the
// compiled backend, built by `npm run build` before deployment; which half
// of it runs is decided by BEAVER402_ROLE in the project's settings.
export { default } from "../dist/index.js";
