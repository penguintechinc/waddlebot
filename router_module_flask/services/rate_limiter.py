"""Rate Limiter - Sliding window rate limiting"""
from datetime import datetime

class RateLimiter:
    def __init__(self):
        self.windows = {}

    async def check_rate_limit(self, key: str, limit: int = 60, window: int = 60) -> bool:
        now = datetime.utcnow().timestamp()
        if key not in self.windows:
            self.windows[key] = {'count': 1, 'start': now}
            return True

        window_data = self.windows[key]
        if now - window_data['start'] >= window:
            self.windows[key] = {'count': 1, 'start': now}
            return True

        if window_data['count'] >= limit:
            return False

        window_data['count'] += 1
        return True
