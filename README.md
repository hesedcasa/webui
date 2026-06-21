# webui

Web UI to browse and execute commands

[![Version](https://img.shields.io/npm/v/@hesed/webui.svg)](https://npmjs.org/package/@hesed/webui)
[![Downloads/week](https://img.shields.io/npm/dw/@hesed/webui.svg)](https://npmjs.org/package/@hesed/webui)

# Install

```bash
sdkck plugins install @hesed/webui
```

<!-- toc -->
* [webui](#webui)
* [Install](#install)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

# Usage

<!-- usage -->
```sh-session
$ npm install -g @hesed/webui
$ webui COMMAND
running command...
$ webui (--version)
@hesed/webui/0.2.6 linux-x64 node-v22.22.3
$ webui --help [COMMAND]
USAGE
  $ webui COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`webui webui`](#webui-webui)

## `webui webui`

Web UI to browse and execute commands

```
USAGE
  $ webui webui [--host <value>] [--open] [-p <value>]

FLAGS
  -p, --port=<value>  [default: 4040] Port to listen on.
      --host=<value>  [default: 127.0.0.1] Host interface to bind.
      --open          Open the UI in the default browser once the server is ready.

DESCRIPTION
  Web UI to browse and execute commands

EXAMPLES
  $ webui webui

  $ webui webui --port 8080 --open

  $ webui webui --host 0.0.0.0
```

_See code: [src/commands/webui.ts](https://github.com/hesedcasa/webui/blob/v0.2.6/src/commands/webui.ts)_
<!-- commandsstop -->
