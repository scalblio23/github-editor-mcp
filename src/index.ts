import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from "cors";
import express from "express";
import { z } from "zod";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const DEFAULT_OWNER = process.env.GITHUB_OWNER || "";
const DEFAULT_REPO = process.env.GITHUB_REPO || "";
const DEFAULT_BRANCH = process.env.GITHUB_BRANCH || "main";
const PORT = parseInt(process.env.PORT || "3000");

if (!GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN environment variable is required");
  process.exit(1);
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

async function githubRequest(
  endpoint: string,
  options: RequestInit = {}
): Promise<any> {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`GitHub API ${res.status}: ${errorText}`);
  }

  return res.json();
}

function getOwnerRepo(owner?: string, repo?: string) {
  return {
    owner: owner || DEFAULT_OWNER,
    repo: repo || DEFAULT_REPO,
  };
}

// ─── MCP Server Setup ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "github-editor",
  version: "1.0.0",
});

// ─── Tool: list_files ─────────────────────────────────────────────────────────

server.tool(
  "github_list_files",
  "List files and directories in a repository path. Returns file names, types, and sizes.",
  {
    path: z.string().default("").describe("Directory path to list (empty for root)"),
    owner: z.string().optional().describe("Repository owner (defaults to configured owner)"),
    repo: z.string().optional().describe("Repository name (defaults to configured repo)"),
    branch: z.string().optional().describe("Branch name (defaults to main)"),
  },
  async ({ path, owner, repo, branch }) => {
    const { owner: o, repo: r } = getOwnerRepo(owner, repo);
    const b = branch || DEFAULT_BRANCH;
    const endpoint = `/repos/${o}/${r}/contents/${path}?ref=${b}`;

    try {
      const data = await githubRequest(endpoint);
      const items = Array.isArray(data) ? data : [data];

      const listing = items.map((item: any) => ({
        name: item.name,
        path: item.path,
        type: item.type, // "file" or "dir"
        size: item.size || 0,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(listing, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }
  }
);

// ─── Tool: read_file ──────────────────────────────────────────────────────────

server.tool(
  "github_read_file",
  "Read the contents of a file from the repository. Returns the full file content as text.",
  {
    path: z.string().describe("File path relative to repository root (e.g., 'src/App.tsx')"),
    owner: z.string().optional().describe("Repository owner"),
    repo: z.string().optional().describe("Repository name"),
    branch: z.string().optional().describe("Branch name"),
  },
  async ({ path, owner, repo, branch }) => {
    const { owner: o, repo: r } = getOwnerRepo(owner, repo);
    const b = branch || DEFAULT_BRANCH;
    const endpoint = `/repos/${o}/${r}/contents/${path}?ref=${b}`;

    try {
      const data = await githubRequest(endpoint);

      if (data.type !== "file") {
        return { content: [{ type: "text" as const, text: `Error: ${path} is a ${data.type}, not a file` }] };
      }

      const content = Buffer.from(data.content, "base64").toString("utf-8");

      return {
        content: [
          {
            type: "text" as const,
            text: content,
          },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }
  }
);

// ─── Tool: write_file ─────────────────────────────────────────────────────────

server.tool(
  "github_write_file",
  "Create or update a file in the repository. Automatically commits the change. If the file exists, it will be updated; if not, it will be created.",
  {
    path: z.string().describe("File path relative to repository root (e.g., 'src/App.tsx')"),
    content: z.string().describe("The full file content to write"),
    message: z.string().default("Update file via Olivia").describe("Commit message describing the change"),
    owner: z.string().optional().describe("Repository owner"),
    repo: z.string().optional().describe("Repository name"),
    branch: z.string().optional().describe("Branch name"),
  },
  async ({ path, content, message, owner, repo, branch }) => {
    const { owner: o, repo: r } = getOwnerRepo(owner, repo);
    const b = branch || DEFAULT_BRANCH;

    try {
      // Check if file exists to get its SHA (needed for updates)
      let sha: string | undefined;
      try {
        const existing = await githubRequest(
          `/repos/${o}/${r}/contents/${path}?ref=${b}`
        );
        sha = existing.sha;
      } catch {
        // File doesn't exist yet — that's fine, we'll create it
      }

      const body: any = {
        message,
        content: Buffer.from(content).toString("base64"),
        branch: b,
      };
      if (sha) body.sha = sha;

      const result = await githubRequest(
        `/repos/${o}/${r}/contents/${path}`,
        { method: "PUT", body: JSON.stringify(body) }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `✅ File ${sha ? "updated" : "created"}: ${path}\nCommit: ${result.commit.sha}\nMessage: ${message}`,
          },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }
  }
);

// ─── Tool: delete_file ────────────────────────────────────────────────────────

server.tool(
  "github_delete_file",
  "Delete a file from the repository. Automatically commits the deletion.",
  {
    path: z.string().describe("File path to delete"),
    message: z.string().default("Delete file via Olivia").describe("Commit message"),
    owner: z.string().optional().describe("Repository owner"),
    repo: z.string().optional().describe("Repository name"),
    branch: z.string().optional().describe("Branch name"),
  },
  async ({ path, message, owner, repo, branch }) => {
    const { owner: o, repo: r } = getOwnerRepo(owner, repo);
    const b = branch || DEFAULT_BRANCH;

    try {
      // Get file SHA
      const existing = await githubRequest(
        `/repos/${o}/${r}/contents/${path}?ref=${b}`
      );

      await githubRequest(`/repos/${o}/${r}/contents/${path}`, {
        method: "DELETE",
        body: JSON.stringify({
          message,
          sha: existing.sha,
          branch: b,
        }),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `✅ File deleted: ${path}\nMessage: ${message}`,
          },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }
  }
);

// ─── Tool: search_code ────────────────────────────────────────────────────────

server.tool(
  "github_search_code",
  "Search for code across the repository. Finds files containing specific text or patterns.",
  {
    query: z.string().describe("Search query (code text to find)"),
    owner: z.string().optional().describe("Repository owner"),
    repo: z.string().optional().describe("Repository name"),
  },
  async ({ query, owner, repo }) => {
    const { owner: o, repo: r } = getOwnerRepo(owner, repo);

    try {
      const data = await githubRequest(
        `/search/code?q=${encodeURIComponent(query)}+repo:${o}/${r}`
      );

      const results = data.items.slice(0, 20).map((item: any) => ({
        path: item.path,
        name: item.name,
        url: item.html_url,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.total_count} results:\n${JSON.stringify(results, null, 2)}`,
          },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }
  }
);

// ─── Tool: list_commits ───────────────────────────────────────────────────────

server.tool(
  "github_list_commits",
  "List recent commits on the repository. Shows commit messages, authors, and dates.",
  {
    count: z.number().default(10).describe("Number of commits to return (max 30)"),
    path: z.string().optional().describe("Filter commits to a specific file path"),
    owner: z.string().optional().describe("Repository owner"),
    repo: z.string().optional().describe("Repository name"),
    branch: z.string().optional().describe("Branch name"),
  },
  async ({ count, path, owner, repo, branch }) => {
    const { owner: o, repo: r } = getOwnerRepo(owner, repo);
    const b = branch || DEFAULT_BRANCH;
    let endpoint = `/repos/${o}/${r}/commits?sha=${b}&per_page=${Math.min(count, 30)}`;
    if (path) endpoint += `&path=${encodeURIComponent(path)}`;

    try {
      const data = await githubRequest(endpoint);

      const commits = data.map((item: any) => ({
        sha: item.sha.substring(0, 7),
        message: item.commit.message,
        author: item.commit.author.name,
        date: item.commit.author.date,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(commits, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }
  }
);

// ─── Tool: get_file_tree ──────────────────────────────────────────────────────

server.tool(
  "github_get_file_tree",
  "Get the complete file tree of the repository. Returns all files and directories recursively.",
  {
    owner: z.string().optional().describe("Repository owner"),
    repo: z.string().optional().describe("Repository name"),
    branch: z.string().optional().describe("Branch name"),
  },
  async ({ owner, repo, branch }) => {
    const { owner: o, repo: r } = getOwnerRepo(owner, repo);
    const b = branch || DEFAULT_BRANCH;

    try {
      const data = await githubRequest(
        `/repos/${o}/${r}/git/trees/${b}?recursive=1`
      );

      const tree = data.tree
        .filter((item: any) => item.type === "blob")
        .map((item: any) => item.path);

      return {
        content: [
          {
            type: "text" as const,
            text: `Repository file tree (${tree.length} files):\n${tree.join("\n")}`,
          },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }
  }
);

// ─── Tool: create_branch ──────────────────────────────────────────────────────

server.tool(
  "github_create_branch",
  "Create a new branch from the current main branch. Useful for making changes safely before merging.",
  {
    branch_name: z.string().describe("Name for the new branch (e.g., 'fix/login-bug')"),
    from_branch: z.string().default("main").describe("Branch to create from"),
    owner: z.string().optional().describe("Repository owner"),
    repo: z.string().optional().describe("Repository name"),
  },
  async ({ branch_name, from_branch, owner, repo }) => {
    const { owner: o, repo: r } = getOwnerRepo(owner, repo);

    try {
      // Get the SHA of the source branch
      const ref = await githubRequest(
        `/repos/${o}/${r}/git/ref/heads/${from_branch}`
      );

      // Create new branch
      await githubRequest(`/repos/${o}/${r}/git/refs`, {
        method: "POST",
        body: JSON.stringify({
          ref: `refs/heads/${branch_name}`,
          sha: ref.object.sha,
        }),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Branch created: ${branch_name} (from ${from_branch})`,
          },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }
  }
);

// ─── Tool: get_diff ───────────────────────────────────────────────────────────

server.tool(
  "github_get_diff",
  "Compare two branches or commits and show the differences. Useful for reviewing changes before merging.",
  {
    base: z.string().describe("Base branch or commit SHA"),
    head: z.string().describe("Head branch or commit SHA to compare"),
    owner: z.string().optional().describe("Repository owner"),
    repo: z.string().optional().describe("Repository name"),
  },
  async ({ base, head, owner, repo }) => {
    const { owner: o, repo: r } = getOwnerRepo(owner, repo);

    try {
      const data = await githubRequest(
        `/repos/${o}/${r}/compare/${base}...${head}`
      );

      const summary = {
        status: data.status,
        ahead_by: data.ahead_by,
        behind_by: data.behind_by,
        total_commits: data.total_commits,
        files_changed: data.files.length,
        files: data.files.slice(0, 30).map((f: any) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch?.substring(0, 500),
        })),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
    }
  }
);

// ─── SSE Transport ────────────────────────────────────────────────────────────

const transports: Record<string, SSEServerTransport> = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  transports[sessionId] = transport;
  console.log(`[SSE] New connection: ${sessionId}`);

  res.on("close", () => {
    delete transports[sessionId];
    console.log(`[SSE] Closed: ${sessionId}`);
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  if (!transport) {
    res.status(400).json({ error: "Unknown session" });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// ─── Stateless POST /mcp endpoint ────────────────────────────────────────────

app.post("/mcp", async (req, res) => {
  const body = req.body;
  const { id, method, params } = body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  function sendSSE(data: any) {
    res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    if (method === "initialize") {
      sendSSE({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "github-editor", version: "1.0.0" },
        },
      });
    } else if (method === "tools/list") {
      const tools = [
        {
          name: "github_list_files",
          description: "List files and directories in a repository path. Returns file names, types, and sizes.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path to list (empty for root)", default: "" },
              owner: { type: "string", description: "Repository owner (optional)" },
              repo: { type: "string", description: "Repository name (optional)" },
              branch: { type: "string", description: "Branch name (optional)" },
            },
          },
        },
        {
          name: "github_read_file",
          description: "Read the contents of a file from the repository. Returns the full file content as text.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to repository root (e.g., 'src/App.tsx')" },
              owner: { type: "string", description: "Repository owner (optional)" },
              repo: { type: "string", description: "Repository name (optional)" },
              branch: { type: "string", description: "Branch name (optional)" },
            },
            required: ["path"],
          },
        },
        {
          name: "github_write_file",
          description: "Create or update a file in the repository. Automatically commits the change.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to repository root" },
              content: { type: "string", description: "The full file content to write" },
              message: { type: "string", description: "Commit message describing the change", default: "Update file via Olivia" },
              owner: { type: "string", description: "Repository owner (optional)" },
              repo: { type: "string", description: "Repository name (optional)" },
              branch: { type: "string", description: "Branch name (optional)" },
            },
            required: ["path", "content"],
          },
        },
        {
          name: "github_delete_file",
          description: "Delete a file from the repository. Automatically commits the deletion.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to delete" },
              message: { type: "string", description: "Commit message", default: "Delete file via Olivia" },
              owner: { type: "string", description: "Repository owner (optional)" },
              repo: { type: "string", description: "Repository name (optional)" },
              branch: { type: "string", description: "Branch name (optional)" },
            },
            required: ["path"],
          },
        },
        {
          name: "github_search_code",
          description: "Search for code across the repository. Finds files containing specific text.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query (code text to find)" },
              owner: { type: "string", description: "Repository owner (optional)" },
              repo: { type: "string", description: "Repository name (optional)" },
            },
            required: ["query"],
          },
        },
        {
          name: "github_list_commits",
          description: "List recent commits on the repository. Shows commit messages, authors, and dates.",
          inputSchema: {
            type: "object",
            properties: {
              count: { type: "number", description: "Number of commits to return (max 30)", default: 10 },
              path: { type: "string", description: "Filter commits to a specific file path" },
              owner: { type: "string", description: "Repository owner (optional)" },
              repo: { type: "string", description: "Repository name (optional)" },
              branch: { type: "string", description: "Branch name (optional)" },
            },
          },
        },
        {
          name: "github_get_file_tree",
          description: "Get the complete file tree of the repository. Returns all files and directories recursively.",
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string", description: "Repository owner (optional)" },
              repo: { type: "string", description: "Repository name (optional)" },
              branch: { type: "string", description: "Branch name (optional)" },
            },
          },
        },
        {
          name: "github_create_branch",
          description: "Create a new branch from the current main branch. Useful for safe changes.",
          inputSchema: {
            type: "object",
            properties: {
              branch_name: { type: "string", description: "Name for the new branch" },
              from_branch: { type: "string", description: "Branch to create from", default: "main" },
              owner: { type: "string", description: "Repository owner (optional)" },
              repo: { type: "string", description: "Repository name (optional)" },
            },
            required: ["branch_name"],
          },
        },
        {
          name: "github_get_diff",
          description: "Compare two branches or commits and show the differences.",
          inputSchema: {
            type: "object",
            properties: {
              base: { type: "string", description: "Base branch or commit SHA" },
              head: { type: "string", description: "Head branch or commit SHA to compare" },
              owner: { type: "string", description: "Repository owner (optional)" },
              repo: { type: "string", description: "Repository name (optional)" },
            },
            required: ["base", "head"],
          },
        },
      ];

      sendSSE({
        jsonrpc: "2.0",
        id,
        result: { tools },
      });
    } else if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};

      // Execute the tool via the MCP server internals
      const { owner: o, repo: r } = getOwnerRepo(args.owner, args.repo);
      const b = args.branch || DEFAULT_BRANCH;
      let resultText = "";

      try {
        switch (toolName) {
          case "github_list_files": {
            const path = args.path || "";
            const data = await githubRequest(`/repos/${o}/${r}/contents/${path}?ref=${b}`);
            const items = Array.isArray(data) ? data : [data];
            const listing = items.map((item: any) => ({
              name: item.name,
              path: item.path,
              type: item.type,
              size: item.size || 0,
            }));
            resultText = JSON.stringify(listing, null, 2);
            break;
          }
          case "github_read_file": {
            const data = await githubRequest(`/repos/${o}/${r}/contents/${args.path}?ref=${b}`);
            if (data.type !== "file") {
              resultText = `Error: ${args.path} is a ${data.type}, not a file`;
            } else {
              resultText = Buffer.from(data.content, "base64").toString("utf-8");
            }
            break;
          }
          case "github_write_file": {
            let sha: string | undefined;
            try {
              const existing = await githubRequest(`/repos/${o}/${r}/contents/${args.path}?ref=${b}`);
              sha = existing.sha;
            } catch {}
            const body: any = {
              message: args.message || "Update file via Olivia",
              content: Buffer.from(args.content).toString("base64"),
              branch: b,
            };
            if (sha) body.sha = sha;
            const result = await githubRequest(`/repos/${o}/${r}/contents/${args.path}`, {
              method: "PUT",
              body: JSON.stringify(body),
            });
            resultText = `✅ File ${sha ? "updated" : "created"}: ${args.path}\nCommit: ${result.commit.sha}\nMessage: ${body.message}`;
            break;
          }
          case "github_delete_file": {
            const existing = await githubRequest(`/repos/${o}/${r}/contents/${args.path}?ref=${b}`);
            await githubRequest(`/repos/${o}/${r}/contents/${args.path}`, {
              method: "DELETE",
              body: JSON.stringify({
                message: args.message || "Delete file via Olivia",
                sha: existing.sha,
                branch: b,
              }),
            });
            resultText = `✅ File deleted: ${args.path}`;
            break;
          }
          case "github_search_code": {
            const data = await githubRequest(
              `/search/code?q=${encodeURIComponent(args.query)}+repo:${o}/${r}`
            );
            const results = data.items.slice(0, 20).map((item: any) => ({
              path: item.path,
              name: item.name,
            }));
            resultText = `Found ${data.total_count} results:\n${JSON.stringify(results, null, 2)}`;
            break;
          }
          case "github_list_commits": {
            const count = Math.min(args.count || 10, 30);
            let endpoint = `/repos/${o}/${r}/commits?sha=${b}&per_page=${count}`;
            if (args.path) endpoint += `&path=${encodeURIComponent(args.path)}`;
            const data = await githubRequest(endpoint);
            const commits = data.map((item: any) => ({
              sha: item.sha.substring(0, 7),
              message: item.commit.message,
              author: item.commit.author.name,
              date: item.commit.author.date,
            }));
            resultText = JSON.stringify(commits, null, 2);
            break;
          }
          case "github_get_file_tree": {
            const data = await githubRequest(`/repos/${o}/${r}/git/trees/${b}?recursive=1`);
            const tree = data.tree
              .filter((item: any) => item.type === "blob")
              .map((item: any) => item.path);
            resultText = `Repository file tree (${tree.length} files):\n${tree.join("\n")}`;
            break;
          }
          case "github_create_branch": {
            const fromBranch = args.from_branch || "main";
            const ref = await githubRequest(`/repos/${o}/${r}/git/ref/heads/${fromBranch}`);
            await githubRequest(`/repos/${o}/${r}/git/refs`, {
              method: "POST",
              body: JSON.stringify({
                ref: `refs/heads/${args.branch_name}`,
                sha: ref.object.sha,
              }),
            });
            resultText = `✅ Branch created: ${args.branch_name} (from ${fromBranch})`;
            break;
          }
          case "github_get_diff": {
            const data = await githubRequest(`/repos/${o}/${r}/compare/${args.base}...${args.head}`);
            const summary = {
              status: data.status,
              ahead_by: data.ahead_by,
              behind_by: data.behind_by,
              total_commits: data.total_commits,
              files_changed: data.files.length,
              files: data.files.slice(0, 30).map((f: any) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
              })),
            };
            resultText = JSON.stringify(summary, null, 2);
            break;
          }
          default:
            resultText = `Unknown tool: ${toolName}`;
        }
      } catch (error: any) {
        resultText = `Error: ${error.message}`;
      }

      sendSSE({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: resultText }],
        },
      });
    } else {
      sendSSE({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  } catch (error: any) {
    sendSSE({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error.message },
    });
  }

  res.end();
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "github-editor",
    defaultRepo: `${DEFAULT_OWNER}/${DEFAULT_REPO}`,
    branch: DEFAULT_BRANCH,
  });
});

app.get("/", (req, res) => {
  res.json({
    name: "GitHub Editor MCP Server",
    version: "1.0.0",
    endpoints: {
      mcp: "POST /mcp",
      sse: "GET /sse",
      health: "GET /health",
    },
    defaultRepo: `${DEFAULT_OWNER}/${DEFAULT_REPO}`,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`GitHub Editor MCP Server running on port ${PORT}`);
  console.log(`Default repo: ${DEFAULT_OWNER}/${DEFAULT_REPO} (branch: ${DEFAULT_BRANCH})`);
  console.log(`Endpoints: POST /mcp, GET /sse, GET /health`);
});
