// Kwetu Nakama Go-runtime module.
//
// Toolchain and dependency pins are LOAD-COMPATIBILITY requirements, not style:
// a Nakama Go plugin is dynamically linked into the server binary and every
// package shared with the host must carry an identical build ID. The pins below
// were read from the running server's own build metadata — never bumped
// casually; re-derive them at every Nakama version bump (README.md §Upgrading):
//
//   docker run --rm golang:1.25.5 go version -m <nakama binary>
//
// → nakama 3.37.0: built with go1.25.5, CGO_ENABLED=1, GOOS=linux, GOARCH=amd64;
//   depends on github.com/heroiclabs/nakama-common v1.44.2,
//   google.golang.org/protobuf v1.36.11, google.golang.org/grpc v1.78.0.
module kwetu/server/runtime-go

go 1.25.5

require github.com/heroiclabs/nakama-common v1.44.2

require google.golang.org/protobuf v1.36.11 // indirect
