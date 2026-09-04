"use strict";

const api = require("./dist/index.cjs");
const loader = api.default;

Object.assign(loader, api);
module.exports = loader;
