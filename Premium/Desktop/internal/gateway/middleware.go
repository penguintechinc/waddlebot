package gateway

import (
	"net/http"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
	"golang.org/x/time/rate"
)

// loggingMiddleware logs all HTTP requests
func (g *Gateway) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// Create response writer wrapper to capture status code
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		next.ServeHTTP(rw, r)

		duration := time.Since(start)
		g.logger.WithFields(logrus.Fields{
			"method":      r.Method,
			"path":        r.URL.Path,
			"remote_addr": r.RemoteAddr,
			"status":      rw.statusCode,
			"duration_ms": duration.Milliseconds(),
		}).Info("HTTP request")
	})
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// authMiddleware validates API key authentication
func (g *Gateway) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip auth for health check
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}

		// Get API key from header
		apiKey := r.Header.Get("X-API-Key")
		if apiKey == "" {
			// Try query parameter as fallback
			apiKey = r.URL.Query().Get("api_key")
		}

		// Validate API key
		if apiKey != g.config.APIKey {
			g.logger.WithFields(logrus.Fields{
				"path":        r.URL.Path,
				"remote_addr": r.RemoteAddr,
			}).Warn("Unauthorized access attempt")

			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// rateLimitMiddleware implements per-IP rate limiting
func (g *Gateway) rateLimitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip rate limiting for health check
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}

		// Get client IP
		ip := getClientIP(r)

		// Get or create rate limiter for this IP
		limiter := g.getRateLimiter(ip)

		// Check if request is allowed
		if !limiter.Allow() {
			g.logger.WithFields(logrus.Fields{
				"ip":   ip,
				"path": r.URL.Path,
			}).Warn("Rate limit exceeded")

			w.Header().Set("Retry-After", "1")
			http.Error(w, `{"error":"rate limit exceeded"}`, http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// getRateLimiter gets or creates a rate limiter for an IP
func (g *Gateway) getRateLimiter(ip string) *rate.Limiter {
	g.limiterMux.RLock()
	limiter, exists := g.rateLimiters[ip]
	g.limiterMux.RUnlock()

	if exists {
		return limiter
	}

	// Create new limiter (requests per second, burst)
	g.limiterMux.Lock()
	defer g.limiterMux.Unlock()

	// Double-check after acquiring write lock
	if limiter, exists := g.rateLimiters[ip]; exists {
		return limiter
	}

	// Create limiter with configured RPS and burst of 2x
	limiter = rate.NewLimiter(rate.Limit(g.config.RateLimitRPS), g.config.RateLimitRPS*2)
	g.rateLimiters[ip] = limiter

	return limiter
}

// corsMiddleware adds CORS headers
func (g *Gateway) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")

		// Check if origin is allowed
		if origin != "" && g.isOriginAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
			w.Header().Set("Access-Control-Max-Age", "86400")
		}

		// Handle preflight requests
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// isOriginAllowed checks if an origin is in the allowed list
func (g *Gateway) isOriginAllowed(origin string) bool {
	// If no origins configured, allow all
	if len(g.config.AllowedOrigins) == 0 {
		return true
	}

	// Check if origin is in allowed list
	for _, allowed := range g.config.AllowedOrigins {
		if allowed == "*" || allowed == origin {
			return true
		}
	}

	return false
}

// getClientIP extracts the client IP from the request
func getClientIP(r *http.Request) string {
	// Try X-Forwarded-For header
	xff := r.Header.Get("X-Forwarded-For")
	if xff != "" {
		ips := strings.Split(xff, ",")
		return strings.TrimSpace(ips[0])
	}

	// Try X-Real-IP header
	xri := r.Header.Get("X-Real-IP")
	if xri != "" {
		return xri
	}

	// Fall back to RemoteAddr
	ip := r.RemoteAddr
	if colon := strings.LastIndex(ip, ":"); colon != -1 {
		ip = ip[:colon]
	}

	return ip
}
