// Kwetu — LiveKit voice-token minting (NETWORKING.md §10).
//
// "Auth: the Go runtime mints the token." There is no official
// Nakama–LiveKit integration; this file writes the HS256 JWT itself with
// stdlib only (crypto/hmac + encoding/base64 + encoding/json) — deliberately
// no JWT dependency, so the plugin brings no third-party package that could
// drift from the host binary's linkage.
//
// Token shape verified against the upstream LiveKit protocol source
// [EXTERNAL — verified 2026-09-06, github.com/livekit/protocol v1.50.4
// auth/accesstoken.go + auth/grants.go]:
//   - JWT header  {"alg":"HS256","typ":"JWT"}, signed with the API secret
//     (upstream: jwt.NewWithClaims(jwt.SigningMethodHS256, claims)).
//   - registered claims: iss = API key, sub = participant identity,
//     iat = nbf = now, exp = now + validFor (upstream defaultValidDuration
//     6 h — the same TTL constant this file uses).
//   - grant claims flattened at the payload top level alongside the
//     registered claims (upstream embeds ClaimGrants into tokenClaims):
//     "identity" (the participant identity) and "video": {"room",
//     "roomJoin","canPublish","canSubscribe","canPublishData", ...} with
//     exactly those camelCase JSON tags.
//   - the can* permissions are *bool upstream, and "if none of the
//     permissions are set explicitly it will be granted with all publish
//     and subscribe permissions" (grants.go) — i.e. ABSENT means ALLOWED.
//     This file therefore mirrors the pointer shape and always sets the
//     three permissions EXPLICITLY: the NETWORKING.md §12 listen-only
//     token for suspended users (Phase 6) must encode canPublish:false,
//     never omit it.
//
// Secrets: the API key/secret are read from environment lookups only
// (runtime env, then process env). They are NEVER logged, never hardcoded,
// and .env is never read by code or tests. If unset the RPC returns a
// structured error — it must not panic.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Voice token TTL. Upstream LiveKit's default token validity is 6 h
// [EXTERNAL — verified 2026-09-06, auth/accesstoken.go defaultValidDuration].
// [PLACEHOLDER — gate: Phase 6 ratifies the rotation policy.]
const voiceTokenTTL = 6 * time.Hour

// voiceRoomMaxLen bounds the room identifier; rooms are [A-Za-z0-9_-] only.
const voiceRoomMaxLen = 64

var (
	errVoiceNotConfigured = errors.New("voice is not configured on this server: LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_HOST are not set in the runtime environment")
	errVoiceBadRoom       = errors.New("voice: room id must be 1-64 characters of [A-Za-z0-9_-]")
)

// VideoGrant mirrors the LiveKit VideoGrant JSON tags [EXTERNAL — verified
// 2026-09-06, github.com/livekit/protocol v1.50.4 auth/grants.go]. The can*
// permissions are *bool upstream (nil = absent = granted by default), so a
// DENIAL must be an explicit false — this pointer shape is what keeps the
// Phase-6 listen-only token honest.
type VideoGrant struct {
	Room           string `json:"room,omitempty"`
	RoomJoin       bool   `json:"roomJoin,omitempty"`
	CanPublish     *bool  `json:"canPublish,omitempty"`
	CanSubscribe   *bool  `json:"canSubscribe,omitempty"`
	CanPublishData *bool  `json:"canPublishData,omitempty"`
}

// ClaimGrants is the LiveKit top-level claim payload: the registered claims
// (set separately) plus these fields flattened alongside them.
type ClaimGrants struct {
	Identity string     `json:"identity,omitempty"`
	Name     string     `json:"name,omitempty"`
	Video    VideoGrant `json:"video,omitempty"`
}

// jwtClaims is the full JWT payload: registered claims + flattened grants,
// the same shape upstream's tokenClaims{RegisteredClaims, ClaimGrants}
// produces.
type jwtClaims struct {
	Issuer    string `json:"iss"`
	Subject   string `json:"sub"`
	IssuedAt  int64  `json:"iat"`
	NotBefore int64  `json:"nbf"`
	Expires   int64  `json:"exp"`

	Identity string     `json:"identity,omitempty"`
	Video    VideoGrant `json:"video,omitempty"`
}

// MintVoiceToken mints one HS256 LiveKit access token. now is injected for
// testability. Returns the compact JWT.
func MintVoiceToken(apiKey, apiSecret, identity, room string, now time.Time) (string, error) {
	if apiKey == "" || apiSecret == "" {
		return "", errVoiceNotConfigured
	}
	if !validRoomName(room) {
		return "", errVoiceBadRoom
	}
	if identity == "" {
		return "", errors.New("voice: identity must not be empty")
	}

	header, err := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	if err != nil {
		return "", fmt.Errorf("voice: header encode: %w", err)
	}
	exp := now.Add(voiceTokenTTL)
	granted := true // explicit true, never omitted: absent means ALLOWED upstream
	payload, err := json.Marshal(jwtClaims{
		Issuer:    apiKey,
		Subject:   identity,
		IssuedAt:  now.Unix(),
		NotBefore: now.Unix(),
		Expires:   exp.Unix(),
		Identity:  identity,
		Video: VideoGrant{
			Room:           room,
			RoomJoin:       true,
			CanPublish:     &granted,
			CanSubscribe:   &granted,
			CanPublishData: &granted,
		},
	})
	if err != nil {
		return "", fmt.Errorf("voice: payload encode: %w", err)
	}

	enc := base64.RawURLEncoding
	signingInput := enc.EncodeToString(header) + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(apiSecret))
	mac.Write([]byte(signingInput))
	sig := mac.Sum(nil)

	var b strings.Builder
	b.WriteString(signingInput)
	b.WriteByte('.')
	b.WriteString(enc.EncodeToString(sig))
	return b.String(), nil
}

// VerifyVoiceTokenSignature re-derives the HS256 signature of a minted token
// (used by the unit tests to prove the mint is a well-formed, correctly
// signed JWT without any JWT dependency).
func VerifyVoiceTokenSignature(token, apiSecret string) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return errors.New("voice: token is not a three-segment compact JWT")
	}
	enc := base64.RawURLEncoding
	sig, err := enc.DecodeString(parts[2])
	if err != nil {
		return fmt.Errorf("voice: signature is not base64url: %w", err)
	}
	mac := hmac.New(sha256.New, []byte(apiSecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return errors.New("voice: HS256 signature mismatch")
	}
	return nil
}

func validRoomName(room string) bool {
	if room == "" || len(room) > voiceRoomMaxLen {
		return false
	}
	for _, r := range room {
		switch {
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}
