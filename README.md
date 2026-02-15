# fluffy-disco

## Intelligent Shard Coordination Layer

**fluffy-disco** represents a backend-level coordination layer designed to tame complexity in modern sharded database architectures. It acts as an intelligent middleware that understands your data distribution, optimizing how queries are planned, executed, and aggregated across partitions.

---

## 🛑 The Challenge

Modern backend systems often struggle when scaling across sharded databases. As data grows, developers face a recurring set of distinct distributed system problems:

- **Cross-Shard Queries**: Simple logical queries become complex scatter-gather operations.
- **N+1 Query Explosions**: Naive fetching logic leads to massive network overhead.
- **Hot Partitions**: Uneven query distribution degrades system-wide performance.
- **Inconsistent Reads**: Racing writes and reads across shards lead to data anomalies.
- **Fragile Logic**: Ad-hoc handling of these issues leads to scattered, unmaintainable code within application services.

## ⚡ The Solution

**fluffy-disco** solves these problems by centralizing shard-aware logic into a dedicated coordination layer. Instead of treating sharding as an infrastructure detail that leaks into application code, this library handles the complexity of distributed data access.

### Core Capabilities

- **Topology Awareness**: The library maintains a deep understanding of the shard topology, routing queries precisely where the data resides.
- **Intelligent Query Planning**: It analyzes requests to create optimized execution plans, minimizing cross-shard chatter.
- **Parallel Execution**: Queries are executed concurrently across targeted shards, significantly reducing latency.
- **Deterministic Result Merging**: Partial results from multiple shards are aggregated and sorted deterministically before being returned to the application.
- **Bounded Consistency**: Enforces strict consistency models to prevent read-after-write anomalies, ensuring data reliability.

## 🚀 Key Benefits

| Benefit | Description |
| ------- | ----------- |
| **Reduced Overhead** | Optimizes network usage by eliminating redundant or N+1 queries. |
| **Predictable Performance** | Intelligent routing and parallel execution smooth out latency spikes. |
| **Cleaner Codebase** | Removes ad-hoc sharding logic from business services, allowing developers to focus on features, not infrastructure. |

---

## 🚀 Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:
- **Node.js** (>= 18.0.0)
- **Docker Desktop** (for running PostgreSQL shards)
- **npm** (comes with Node.js)

### 1. Stop Existing PostgreSQL Services

**⚠️ IMPORTANT**: Before starting Docker containers, you must stop any existing PostgreSQL services running locally on your machine. This prevents port conflicts.

**On Windows:**
```powershell
# Open Services (Win + R, type 'services.msc')
# Find 'postgresql' service and stop it
# OR use PowerShell:
Stop-Service -Name postgresql*
```

**On macOS/Linux:**
```bash
# Check if PostgreSQL is running
sudo systemctl status postgresql
# Stop the service
sudo systemctl stop postgresql
```

### 2. Start Docker Containers

**Why Docker?**  
This project uses Docker to run multiple PostgreSQL database shards in isolated containers. Docker provides:
- **Consistent Environment**: Same database setup across all development machines
- **Isolated Shards**: Each shard runs on a separate port (15433, 15434) without conflicts
- **Easy Cleanup**: Tear down and recreate databases instantly
- **No Local Installation**: No need to install PostgreSQL directly on your machine

**How to Start Docker:**

```bash
# Start PostgreSQL shards in detached mode (runs in background)
npm run docker:up
```

This command:
- Starts two PostgreSQL 16 containers (`shard_1` on port 15433, `shard_2` on port 15434)
- Creates persistent volumes for data storage
- Runs health checks to ensure databases are ready

**Useful Docker Commands:**
```bash
# View container logs
npm run docker:logs

# Stop containers (keeps data)
npm run docker:down

# Restart containers
npm run docker:down && npm run docker:up
```

### 3. Install Dependencies

Install all required packages for the monorepo:

```bash
# Install dependencies for all workspaces
npm install
```

This installs dependencies for:
- Root workspace (TypeScript, ts-node, nodemon)
- All packages in `packages/*` directory

### 4. Run Tests

Execute the test suite to verify everything is working:

```bash
# Run all tests across all packages
npm test
```

This command runs tests in all workspace packages that have a `test` script defined.

**Run tests for a specific package:**
```bash
# Navigate to the package directory
cd packages/core
npm test
```

---

## 📁 Project Structure

```
fluffy-disco/
├── packages/                    # Monorepo packages
│   └── core/                    # Core coordination library
│       ├── src/                 # Library source code
│       │   └── index.ts         # Main library entry point
│       ├── test/                # Test files
│       │   └── connection.test.ts  # Connection tests
│       ├── package.json         # Package dependencies & scripts
│       └── jest.config.js       # Jest test configuration
├── docker-compose.yml           # PostgreSQL shard containers
├── package.json                 # Root workspace configuration
└── README.md                    # This file
```

**Key Directories:**
- **`packages/core/src/`**: Contains the actual library code for the shard coordination layer
- **`packages/core/test/`**: Contains all test files (using Jest framework)
- **`docker-compose.yml`**: Defines the PostgreSQL shard containers configuration
