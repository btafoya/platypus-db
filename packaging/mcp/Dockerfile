# PlatypusDB's MCP server (`platypus-db --mcp`, over stdio) from the Linux .deb of a release,
# for directories that start a server in a container to check it, such as Glama. It runs
# without a display; with no saved connections it answers with the tools and an empty list.
#   docker build -t platypusdb-mcp packaging/mcp
#   docker run -i --rm platypusdb-mcp
FROM debian:trixie-slim
ARG VERSION=0.6.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /tmp/platypusdb.deb \
    "https://github.com/platypus-labs/platypus-db/releases/download/v${VERSION}/PlatypusDB_${VERSION}_amd64.deb" \
 && apt-get install -y --no-install-recommends /tmp/platypusdb.deb \
 && rm -rf /tmp/platypusdb.deb /var/lib/apt/lists/*
ENTRYPOINT ["platypus-db", "--mcp"]
