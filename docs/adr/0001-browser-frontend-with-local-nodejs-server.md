# Browser frontend with a local Node.js server

ModelViz Studio runs as a browser UI backed by a Node.js server on the user's machine, rather than as a pure browser app using Web Serial or a desktop shell. The application's scope (device I/O, recording, model computation and other heavy features) is much wider than a configurator's, and a local server gives unrestricted access to serial ports, the filesystem and native toolchains/runtimes, independent of browser support.

## Consequences

- The browser never talks to hardware directly; all Device I/O goes through the server.
- Users must start the server before using the UI; a pure-hosted web version is not a goal.
