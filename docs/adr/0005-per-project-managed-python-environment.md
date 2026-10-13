# Each Project gets a server-managed Python environment

The local server creates and manages an isolated Python environment per Project, installed from the Project's declared dependencies, instead of using whatever Python the user has or bundling one with the app. This keeps Python Blocks reproducible when a Project moves between machines, at the cost of the server owning environment creation and dependency installation.
