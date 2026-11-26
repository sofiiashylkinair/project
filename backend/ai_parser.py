"""ШІ-парсер новин: текст новини -> інцидент із координатами.
Потрібен ключ Google AI Studio у змінній середовища GEMINI_API_KEY.
Координати беремо безкоштовно з OpenStreetMap (Nominatim).
"""
import json
import os
import urllib.parse
import urllib.request
from datetime import date

MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")  # назву моделі перевір в AI Studio
CRIME_TYPES = {"violent", "robbery", "burglary", "theft"}

PROMPT = """Ти аналізуєш текст новини місцевої преси Львова.
Поверни ТІЛЬКИ JSON такого вигляду:
{"is_crime": true|false,
 "crime_type": "violent|robbery|burglary|theft",
 "address": "вулиця або місце у Львові, без імен людей",
 "time_of_day": "morning|day|evening|night|null",
 "summary": "одне нейтральне речення українською"}
Правила:
- is_crime=false, якщо це не злочин або подія не у Львові.
- violent = напад/насильство, robbery = грабіж/розбій, burglary = крадіжка з житла, theft = кишенькова/звичайна крадіжка.
- У summary НЕ вказуй імен, віку чи подробиць про постраждалих.
Текст новини:
"""


def _request(url, payload=None, headers=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def call_gemini(text):
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("Не задано GEMINI_API_KEY")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    body = {
        "contents": [{"parts": [{"text": PROMPT + text}]}],
        "generationConfig": {"responseMimeType": "application/json"},
    }
    headers = {"Content-Type": "application/json", "x-goog-api-key": key}
    data = _request(url, body, headers)
    raw = data["candidates"][0]["content"]["parts"][0]["text"]
    return raw.strip().removeprefix("```json").removesuffix("```").strip()


def geocode(address):
    params = urllib.parse.urlencode(
        {"q": f"{address}, Львів, Україна", "format": "json", "limit": 1, "countrycodes": "ua"}
    )
    url = "https://nominatim.openstreetmap.org/search?" + params
    res = _request(url, headers={"User-Agent": "SafeZoneStudentProject/1.0"})
    if not res:
        return None
    return float(res[0]["lat"]), float(res[0]["lon"])


def parse_news_text(text):
    """Повертає dict інциденту або None, якщо це не злочин / адресу не знайдено."""
    info = json.loads(call_gemini(text))
    if not info.get("is_crime") or not info.get("address"):
        return None
    point = geocode(info["address"])
    if not point:
        return None
    ctype = info.get("crime_type") if info.get("crime_type") in CRIME_TYPES else "theft"
    tod = info.get("time_of_day")
    return {
        "latitude": point[0],
        "longitude": point[1],
        "category": "real_estate" if ctype == "burglary" else "tourist",
        "crime_type": ctype,
        "description": info.get("summary") or "Подію виявлено ШІ-парсером",
        "date": date.today().isoformat(),
        "time_of_day": tod if tod in {"morning", "day", "evening", "night"} else None,
        "source": "ai",
        "approx": 1,
    }
