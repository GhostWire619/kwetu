// Kwetu — voice-token minting tests (NETWORKING.md §10).
//
// The mint is verified here WITHOUT any JWT dependency and WITHOUT a live
// LiveKit: the compact JWT is decoded segment by segment, the HS256
// signature is re-derived, and the claim payload is asserted against the
// upstream claim shape read from source [EXTERNAL — verified 2026-09-06,
// github.com/livekit/protocol v1.50.4 auth/accesstoken.go + auth/grants.go].
// A full room join against a real LiveKit is the Phase-6 exit criterion and
// is deliberately NOT claimed here.
package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func boolPtr(b bool) *bool { return &b }

// decodeJWT splits and decodes a compact JWT into raw header/payload JSON.
func decodeJWT(t *testing.T, token string) (headerRaw, payloadRaw []byte) {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d segments, want 3", len(parts))
	}
	enc := base64.RawURLEncoding
	var err error
	headerRaw, err = enc.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("header segment: %v", err)
	}
	payloadRaw, err = enc.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("payload segment: %v", err)
	}
	sig, err := enc.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("signature segment: %v", err)
	}
	if len(sig) != 32 {
		t.Fatalf("HS256 signature = %d bytes, want 32", len(sig))
	}
	return headerRaw, payloadRaw
}

func TestMintVoiceTokenHeaderAndSignature(t *testing.T) {
	token, err := MintVoiceToken("devkey", "devsecret", "user-uuid", "room-1", time.Unix(1780000000, 0))
	if err != nil {
		t.Fatal(err)
	}
	headerRaw, _ := decodeJWT(t, token)
	var header map[string]string
	if err := json.Unmarshal(headerRaw, &header); err != nil {
		t.Fatal(err)
	}
	if header["alg"] != "HS256" || header["typ"] != "JWT" {
		t.Fatalf("header = %v, want alg HS256 + typ JWT", header)
	}
	if err := VerifyVoiceTokenSignature(token, "devsecret"); err != nil {
		t.Fatalf("signature does not verify with the minting secret: %v", err)
	}
	if err := VerifyVoiceTokenSignature(token, "wrong-secret"); err == nil {
		t.Fatal("signature verified with the wrong secret")
	}
	// Tampering with the payload must break the signature.
	parts := strings.Split(token, ".")
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"attacker"}`)) + "." + parts[2]
	if err := VerifyVoiceTokenSignature(tampered, "devsecret"); err == nil {
		t.Fatal("tampered payload passed signature verification")
	}
}

func TestMintVoiceTokenClaimsMatchUpstreamShape(t *testing.T) {
	now := time.Unix(1780000000, 0)
	token, err := MintVoiceToken("APIkey123", "secret", "user-uuid", "world-region", now)
	if err != nil {
		t.Fatal(err)
	}
	_, payloadRaw := decodeJWT(t, token)

	// Upstream shape: registered claims + grants flattened at the TOP level
	// (tokenClaims embeds ClaimGrants), so there is no nested "grants" object.
	var flat map[string]any
	if err := json.Unmarshal(payloadRaw, &flat); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"iss", "sub", "iat", "nbf", "exp", "identity", "video"} {
		if _, ok := flat[key]; !ok {
			t.Fatalf("claim %q missing from the payload; upstream flattens grants alongside the registered claims", key)
		}
	}
	if flat["iss"] != "APIkey123" {
		t.Fatalf("iss = %v, want the API key", flat["iss"])
	}
	if flat["sub"] != "user-uuid" || flat["identity"] != "user-uuid" {
		t.Fatalf("sub/identity = %v/%v, want the participant identity", flat["sub"], flat["identity"])
	}
	if flat["iat"] != float64(now.Unix()) || flat["nbf"] != float64(now.Unix()) {
		t.Fatalf("iat/nbf = %v/%v, want %d (upstream sets both to now)", flat["iat"], flat["nbf"], now.Unix())
	}
	if got, want := flat["exp"], float64(now.Add(voiceTokenTTL).Unix()); got != want {
		t.Fatalf("exp = %v, want %v (TTL %v)", got, want, voiceTokenTTL)
	}

	// The video grant: room + roomJoin + all three permissions EXPLICITLY
	// present (absent would mean default-allow upstream — the pointer shape
	// exists so the Phase-6 listen-only token can encode false).
	video, ok := flat["video"].(map[string]any)
	if !ok {
		t.Fatalf("video = %#v, want an object", flat["video"])
	}
	if video["room"] != "world-region" {
		t.Fatalf("video.room = %v, want world-region", video["room"])
	}
	if video["roomJoin"] != true {
		t.Fatalf("video.roomJoin = %v, want true", video["roomJoin"])
	}
	for _, key := range []string{"canPublish", "canSubscribe", "canPublishData"} {
		if video[key] != true {
			t.Fatalf("video.%s = %v, want explicit true (never omitted: absent = default-allow upstream)", key, video[key])
		}
	}
	if len(video) != 5 {
		t.Fatalf("video grant has %d fields (%v), want exactly the 5 the mint sets", len(video), video)
	}
}

func TestMintVoiceTokenEncodesExplicitFalse(t *testing.T) {
	// The Phase-6 listen-only token (NETWORKING.md §12: suspended users) must
	// be able to say canPublish:false — a plain-bool false would be OMITTED by
	// omitempty and silently read as default-allow by the LiveKit server.
	grant := VideoGrant{
		Room:           "room",
		RoomJoin:       true,
		CanPublish:     boolPtr(false),
		CanSubscribe:   boolPtr(true),
		CanPublishData: boolPtr(false),
	}
	b, err := json.Marshal(grant)
	if err != nil {
		t.Fatal(err)
	}
	var video map[string]any
	if err := json.Unmarshal(b, &video); err != nil {
		t.Fatal(err)
	}
	if v, ok := video["canPublish"]; !ok || v != false {
		t.Fatalf("canPublish = %v (present=%v), want an explicit false on the wire", video["canPublish"], ok)
	}
	if v, ok := video["canPublishData"]; !ok || v != false {
		t.Fatalf("canPublishData = %v (present=%v), want an explicit false on the wire", video["canPublishData"], ok)
	}
	if v, ok := video["canSubscribe"]; !ok || v != true {
		t.Fatalf("canSubscribe = %v (present=%v), want true", video["canSubscribe"], ok)
	}
}

func TestMintVoiceTokenRejectsBadInput(t *testing.T) {
	if _, err := MintVoiceToken("", "secret", "u", "room", time.Now()); err == nil {
		t.Fatal("empty API key must error")
	}
	if _, err := MintVoiceToken("key", "", "u", "room", time.Now()); err == nil {
		t.Fatal("empty API secret must error")
	}
	if _, err := MintVoiceToken("key", "secret", "", "room", time.Now()); err == nil {
		t.Fatal("empty identity must error")
	}
	for _, room := range []string{"", "has space", "has/slash", "emoji-🗣", strings.Repeat("x", voiceRoomMaxLen+1)} {
		if _, err := MintVoiceToken("key", "secret", "u", room, time.Now()); err == nil {
			t.Fatalf("room %q must be rejected", room)
		}
	}
	if _, err := MintVoiceToken("key", "secret", "u", strings.Repeat("x", voiceRoomMaxLen), time.Now()); err != nil {
		t.Fatalf("a %d-char room of [A-Za-z0-9_-] must be accepted: %v", voiceRoomMaxLen, err)
	}
}

func TestValidRoomName(t *testing.T) {
	for _, room := range []string{"kwetu-global", "Region_1", "stone-town-9", "a", "_-"} {
		if !validRoomName(room) {
			t.Errorf("validRoomName(%q) = false, want true", room)
		}
	}
	for _, room := range []string{"", "Kilwa Kisiwani", "region/1", "zanzibar.v1", strings.Repeat("x", voiceRoomMaxLen+1)} {
		if validRoomName(room) {
			t.Errorf("validRoomName(%q) = true, want false", room)
		}
	}
}
