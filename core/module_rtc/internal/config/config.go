package config

import (
	"os"
	"strconv"
)

type Config struct {
	ModulePort       int
	GrpcPort         int
	ModuleName       string
	ModuleVersion    string
	LiveKitHost      string
	LiveKitAPIKey    string
	LiveKitAPISecret string
	DatabaseURL      string
	LogLevel         string
	HubAPIURL        string
}

func LoadConfig() *Config {
	return &Config{
		ModulePort:       getEnvInt("MODULE_PORT", 8093),
		GrpcPort:         getEnvInt("GRPC_PORT", 50067),
		ModuleName:       getEnv("MODULE_NAME", "module_rtc"),
		ModuleVersion:    getEnv("MODULE_VERSION", "1.0.0"),
		LiveKitHost:      getEnv("LIVEKIT_HOST", "localhost:7880"),
		LiveKitAPIKey:    getEnv("LIVEKIT_API_KEY", ""),
		LiveKitAPISecret: getEnv("LIVEKIT_API_SECRET", ""),
		DatabaseURL:      getEnv("DATABASE_URL", "postgres://waddlebot:password@localhost:5432/waddlebot"),
		LogLevel:         getEnv("LOG_LEVEL", "INFO"),
		HubAPIURL:        getEnv("HUB_API_URL", "http://hub-api:8060"),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}
