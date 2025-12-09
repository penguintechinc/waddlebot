package models

import "time"

// AuthSession represents an active authentication session.
type AuthSession struct {
	ID          string    `json:"id"`
	UserID      string    `json:"user_id"`
	CommunityID string    `json:"community_id"`
	IssuedAt    time.Time `json:"issued_at"`
	ExpiresAt   time.Time `json:"expires_at"`
	Credential  []byte    `json:"credential"`
}
