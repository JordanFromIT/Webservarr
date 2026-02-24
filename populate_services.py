"""
Script to populate the database with sample services.
Run this script once to initialize the service status data.
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.models import Service, ServiceStatus, Base
import os

# Database URL
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:////app/data/hms.db")

# If running locally (not in container), adjust path
if not os.path.exists("/app/data"):
    DATABASE_URL = "sqlite:///./data/hms.db"
    os.makedirs("./data", exist_ok=True)

# Create engine and session
engine = create_engine(DATABASE_URL.replace("sqlite:////", "sqlite:///"))
SessionLocal = sessionmaker(bind=engine)

# Create tables if they don't exist
Base.metadata.create_all(bind=engine)

db = SessionLocal()

# Sample services to create
sample_services = [
    {
        "name": "plex",
        "display_name": "Plex Media Server",
        "description": "Media streaming server",
        "status": ServiceStatus.UP,
        "status_message": "99.9% Uptime",
        "url": "https://plex.hmserver.tv",
        "icon": "play_circle",
        "requires_auth": True,
        "enabled": True
    },
    {
        "name": "overseerr",
        "display_name": "Overseerr",
        "description": "Media request management",
        "status": ServiceStatus.UP,
        "status_message": "Operational",
        "url": "https://overseerr.hmserver.tv",
        "icon": "download",
        "requires_auth": True,
        "enabled": True
    },
    {
        "name": "radarr",
        "display_name": "Radarr",
        "description": "Movie collection manager",
        "status": ServiceStatus.UP,
        "status_message": "Operational",
        "url": "https://radarr.hmserver.tv",
        "icon": "movie",
        "requires_auth": True,
        "enabled": True
    },
    {
        "name": "sonarr",
        "display_name": "Sonarr",
        "description": "TV series collection manager",
        "status": ServiceStatus.DEGRADED,
        "status_message": "High Load",
        "url": "https://sonarr.hmserver.tv",
        "icon": "tv_guide",
        "requires_auth": True,
        "enabled": True
    },
    {
        "name": "tautulli",
        "display_name": "Tautulli",
        "description": "Plex monitoring and statistics",
        "status": ServiceStatus.DOWN,
        "status_message": "Service Unavailable",
        "url": "https://tautulli.hmserver.tv",
        "icon": "bar_chart",
        "requires_auth": True,
        "enabled": True
    }
]

print("Populating database with sample services...")

for service_data in sample_services:
    # Check if service already exists
    existing = db.query(Service).filter(Service.name == service_data["name"]).first()

    if existing:
        print(f"✓ Service '{service_data['name']}' already exists, updating...")
        # Update existing service
        for key, value in service_data.items():
            setattr(existing, key, value)
    else:
        print(f"+ Creating service '{service_data['name']}'...")
        # Create new service
        service = Service(**service_data)
        db.add(service)

db.commit()
print("\n✓ Database populated successfully!")
print(f"Total services: {db.query(Service).count()}")

db.close()
