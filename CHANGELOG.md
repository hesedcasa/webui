# Changelog

## [0.2.8](https://github.com/hesedcasa/webui/compare/v0.2.7...v0.2.8) (2026-06-21)


### 🛠️ Fixes

* **server:** set __NEXT_PRIVATE_STANDALONE_CONFIG to suppress lockfile warning ([bde69fc](https://github.com/hesedcasa/webui/commit/bde69fca6889980d9eb05d2dc2715fbb495bd4dc))

## [0.2.7](https://github.com/hesedcasa/webui/compare/v0.2.6...v0.2.7) (2026-06-21)


### 🛠️ Fixes

* **executor:** strip ANSI sequences from output and rebuild inferred topics ([47cf6a4](https://github.com/hesedcasa/webui/commit/47cf6a4e27423bdc40fadb24f8ee009353f6ecf3))

## [0.2.6](https://github.com/hesedcasa/webui/compare/v0.2.5...v0.2.6) (2026-06-21)


### 🛠️ Fixes

* **executor:** bypass Config.load to preserve initialized config state ([5d18c55](https://github.com/hesedcasa/webui/commit/5d18c55c7bdadf80a9422b379c1fd44967a6247a))
* **next:** dynamically resolve turbopack root to silence lockfile warning ([9b23d55](https://github.com/hesedcasa/webui/commit/9b23d555b1a80af41ea54403d33541497f5693cd))
* **next:** dynamically resolve turbopack root to silence lockfile warning ([e7aeaea](https://github.com/hesedcasa/webui/commit/e7aeaeab5229c4bf044ac4b6d76c2988cc01dc4f))

## [0.2.5](https://github.com/hesedcasa/webui/compare/v0.2.4...v0.2.5) (2026-06-20)


### 🛠️ Fixes

* **build:** correct standalone static path for nested Next output ([889ae54](https://github.com/hesedcasa/webui/commit/889ae5415c3d734de4e1827befe7bbc02b270035))

## [0.2.4](https://github.com/hesedcasa/webui/compare/v0.2.3...v0.2.4) (2026-06-20)


### 🛠️ Fixes

* restore turbopack.root and outputFileTracingRoot for monorepo layout ([a0787b1](https://github.com/hesedcasa/webui/commit/a0787b1aeb0a25f533bb26d42d51c9c7dd5aaf1a))

## [0.2.3](https://github.com/hesedcasa/webui/compare/v0.2.2...v0.2.3) (2026-06-20)


### 🛠️ Fixes

* switch Next.js to standalone output for leaner packaging ([51c5130](https://github.com/hesedcasa/webui/commit/51c51309e7d8a149ab8bb8247fb73f9118bb816f))

## [0.2.2](https://github.com/hesedcasa/webui/compare/v0.2.1...v0.2.2) (2026-06-20)


### 🛠️ Fixes

* output Next.js build to dist/web and update packaging ([331d36e](https://github.com/hesedcasa/webui/commit/331d36ed6a0d7d1e2c29adb1da16555ceb97399a))

## [0.2.1](https://github.com/hesedcasa/webui/compare/v0.2.0...v0.2.1) (2026-06-20)


### 🛠️ Fixes

* add build:web script and include Next.js build in prepack ([68c1edb](https://github.com/hesedcasa/webui/commit/68c1edbb65c809e3b1df8d58caca566fd32f2299))

## [0.2.0](https://github.com/hesedcasa/webui/compare/v0.1.0...v0.2.0) (2026-06-20)


### 🎉 Features

* add topic filter, oclif template expansion, and self-command filtering ([f091e51](https://github.com/hesedcasa/webui/commit/f091e51d1fa2044e74f1df88fce866dc79b2990a))
* add topic filter, oclif template expansion, and self-command filtering ([92aae81](https://github.com/hesedcasa/webui/commit/92aae81dbc97a3bc1bc3c20b45f050df9b2c4406))


### 🛠️ Fixes

* pre-load oclif Config to prevent Windows CI race in startup output tests ([fbbc879](https://github.com/hesedcasa/webui/commit/fbbc87976ec96103c71041ce47fef7a2bdb4bd17))
* use .ts extension in esmock mock key to fix Windows CI ([159372b](https://github.com/hesedcasa/webui/commit/159372b7ac86102d7a2caa5480fc47728e1f6b0f))
* use .ts extension in esmock mock key to fix Windows CI ([7dea8db](https://github.com/hesedcasa/webui/commit/7dea8dbe672ae998e884f07b835762e9616a71c3))

## Changelog


All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
