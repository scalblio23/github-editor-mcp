# GitHub Editor MCP Server

MCP server that gives OliviaAI the ability to read, write, search, and manage files in a GitHub repository.

## Tools Available

| Tool | Description |
|------|-------------|
| `list_files` | List files and directories in a repo path |
| `read_file` | Read full file contents |
| `write_file` | Create or update a file (auto-commits) |
| `delete_file` | Delete a file (auto-commits) |
| `search_code` | Search for code across the repo |
| `list_commits` | View recent commit history |
| `get_file_tree` | Get complete recursive file tree |
| `create_branch` | Create a new branch |
| `get_diff` | Compare branches or commits |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token with repo read/write |
| `GITHUB_OWNER` | Yes | Repository owner (e.g., `scalblio23`) |
| `GITHUB_REPO` | Yes | Repository name (e.g., `oliviacrm`) |
| `GITHUB_BRANCH` | No | Default branch (defaults to `main`) |
| `PORT` | No | Server port (defaults to `3000`) |

## Deploy to Railway

1. Push this repo to GitHub
2. Create new project on Railway → Deploy from GitHub
3. Add environment variables (see above)
4. Deploy

## MCP Endpoint

Once deployed, the MCP endpoint is: `https://your-app.up.railway.app/mcp`

Add this URL as an MCP server in OliviaAI Settings.
