import { unusedMessage, usedMessage } from "./dependency.js";

const heading = document.createElement("h1");
heading.textContent = usedMessage();
document.body.append(heading);

const retained = document.createElement("button");
retained.textContent = "Retained branch";
retained.addEventListener("click", () => {
  heading.textContent = unusedMessage();
});
document.body.append(retained);

const lazy = document.createElement("button");
lazy.textContent = "Load lazy chunk";
lazy.addEventListener("click", async () => {
  const module = await import("./lazy.js");
  heading.textContent = module.lazyMessage();
});
document.body.append(lazy);
