# Adobe Express add-on

This panel accepts a product brief, calls the local design-agent API, previews the selected art direction, downloads the product assets, and renders one native editable page in Adobe Express.

## Run

1. Start the API from the repository root: `npm run dev:api`.
2. In this directory run `npm run build`, then `npm run start`.
3. Enable Add-on Development in Adobe Express and connect to the local development server shown by Adobe's CLI.

The default API address is `http://localhost:8787`. To override it from the browser console, set `localStorage.designAgentApi` and reload the add-on.
