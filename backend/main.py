"""SafeZone backend: FastAPI + SQLite.
Запуск (з папки backend, з активним venv):  uvicorn main:app --reload
Документація API:  http://127.0.0.1:8000/docs
"""
import json
import math
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ai_parser import parse_news_text

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "database.db"
SEED_PATH = BASE_DIR / "incidents.json"

WEIGHTS = {"violent": 3, "robbery": 2, "burglary": 2, "theft": 1}
CATEGORIES = {"tourist", "real_estate"}


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def insert_incident(conn, d):
    cur = conn.execute(
        """INSERT INTO incidents
           (latitude, longitude, category, crime_type, description, date, time_of_day, source, approx)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (d["latitude"], d["longitude"], d["category"], d.get("crime_type", "theft"),
         d["description"], d.get("date"), d.get("time_of_day"),
         d.get("source", "official"), d.get("approx", 0)),
    )
    return cur.lastrowid


def init_db():
    with get_conn() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS incidents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                category TEXT NOT NULL CHECK (category IN ('tourist','real_estate')),
                crime_type TEXT NOT NULL DEFAULT 'theft',
                description TEXT NOT NULL,
                date TEXT,
                time_of_day TEXT,
                source TEXT NOT NULL DEFAULT 'official',
                approx INTEGER NOT NULL DEFAULT 0
            )"""
        )
        count = conn.execute("SELECT COUNT(*) FROM incidents").fetchone()[0]
        if count == 0 and SEED_PATH.exists():
            for item in json.loads(SEED_PATH.read_text(encoding="utf-8")):
                insert_incident(conn, item)


@asynccontextmanager
async def lifespan(app):
    init_db()
    yield


app = FastAPI(title="SafeZone API", lifespan=lifespan)

# CORS: дозволяє фронтенду з іншого комп'ютера/порту забирати дані через fetch
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


@app.get("/")
def root():
    return {"status": "ok", "docs": "/docs", "incidents": "/incidents"}


@app.get("/incidents")
def list_incidents(
    category: Optional[str] = None,
    crime_type: Optional[str] = None,
    time_of_day: Optional[str] = None,
):
    query, params = "SELECT * FROM incidents WHERE 1=1", []
    if category:
        query += " AND category = ?"
        params.append(category)
    if crime_type:
        query += " AND crime_type = ?"
        params.append(crime_type)
    if time_of_day:
        query += " AND (time_of_day = ? OR time_of_day IS NULL)"
        params.append(time_of_day)
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(query, params).fetchall()]


@app.get("/risk")
def risk(lat: float, lon: float, radius_m: int = 500, category: Optional[str] = None):
    """Рівень ризику навколо точки: для сторінки вулиці та перевірки адреси."""
    items = list_incidents(category=category)
    near = [i for i in items if haversine_m(lat, lon, i["latitude"], i["longitude"]) <= radius_m]
    score = sum(WEIGHTS.get(i["crime_type"], 1) for i in near)
    by_type = {}
    for i in near:
        by_type[i["crime_type"]] = by_type.get(i["crime_type"], 0) + 1
    level = "low" if score <= 2 else "moderate" if score <= 6 else "high"
    return {"level": level, "score": score, "count": len(near), "by_type": by_type, "radius_m": radius_m}


class IncidentIn(BaseModel):
    latitude: float
    longitude: float
    category: str
    crime_type: str = "theft"
    description: str
    date: Optional[str] = None
    time_of_day: Optional[str] = None


@app.post("/incidents", status_code=201)
def add_incident(body: IncidentIn):
    """Повідомлення від користувачів (краудсорсинг)."""
    if body.category not in CATEGORIES:
        raise HTTPException(400, "category має бути tourist або real_estate")
    if body.crime_type not in WEIGHTS:
        raise HTTPException(400, "crime_type: violent, robbery, burglary або theft")
    data = body.model_dump()
    data["source"] = "user"
    data["approx"] = 1
    with get_conn() as conn:
        data["id"] = insert_incident(conn, data)
    return data


class NewsIn(BaseModel):
    text: str


@app.post("/parse-news")
def parse_news(body: NewsIn):
    """ШІ-парсер: текст новини -> новий інцидент на карті."""
    try:
        data = parse_news_text(body.text)
    except Exception as e:  # немає ключа, мережа, помилка моделі
        raise HTTPException(502, f"Помилка ШІ-парсера: {e}")
    if not data:
        return {"saved": False, "reason": "не злочин у Львові або адресу не знайдено"}
    with get_conn() as conn:
        data["id"] = insert_incident(conn, data)
    return {"saved": True, "incident": data}
