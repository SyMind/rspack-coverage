import { formatGreeting, unusedFormatter } from "./messages.js";

const root = document.createElement("main");
root.innerHTML = `
  <h1>${formatGreeting("Rspack Coverage")}</h1>
  <p>This fixture has an async chunk and deliberately unexecuted source.</p>
  <button type="button">Load async feature</button>
  <pre></pre>
`;
document.body.append(root);

root.querySelector("button").addEventListener("click", async () => {
  const feature = await import(/* webpackChunkName: "feature" */ "./feature.js");
  root.querySelector("pre").textContent = feature.runFeature();
});

export { unusedFormatter };
