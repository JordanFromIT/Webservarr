"""
Service Status API routes
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime


from app.database import get_db
from app.models import StatusUpdate
from app.dependencies import require_admin

router = APIRouter()


# Pydantic schemas
class StatusUpdateResponse(BaseModel):
    """Schema for status update response."""
    id: int
    title: str
    message: str
    update_type: str
    severity: str
    service_name: Optional[str]
    author_name: str
    created_at: datetime
    active: bool
    resolved_at: Optional[datetime]

    class Config:
        from_attributes = True


class StatusUpdateCreate(BaseModel):
    """Schema for creating a status update."""
    title: str
    message: str
    update_type: str  # incident, maintenance, resolved
    severity: str  # info, warning, critical
    service_name: Optional[str] = None


@router.get("/updates", response_model=List[StatusUpdateResponse])
async def get_status_updates(
    active_only: bool = True,
    limit: int = 20,
    db: Session = Depends(get_db)
):
    """
    Get status updates (incidents, maintenance, etc.).
    Public endpoint.
    """
    query = db.query(StatusUpdate)

    if active_only:
        query = query.filter(StatusUpdate.active == True)

    updates = query.order_by(StatusUpdate.created_at.desc()).limit(limit).all()
    return updates


@router.post("/updates", response_model=StatusUpdateResponse, status_code=status.HTTP_201_CREATED)
async def create_status_update(
    update_data: StatusUpdateCreate,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """
    Create a status update.
    Requires admin authentication.
    """
    new_update = StatusUpdate(
        title=update_data.title,
        message=update_data.message,
        update_type=update_data.update_type,
        severity=update_data.severity,
        service_name=update_data.service_name,
        author_id=current_user.get("user_id", ""),
        author_name=current_user.get("name", "Unknown"),
        active=True
    )

    db.add(new_update)
    db.commit()
    db.refresh(new_update)

    return new_update


@router.put("/updates/{update_id}/resolve", response_model=StatusUpdateResponse)
async def resolve_status_update(
    update_id: int,
    current_user: dict = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """
    Mark a status update as resolved.
    Requires admin authentication.
    """
    update = db.query(StatusUpdate).filter(StatusUpdate.id == update_id).first()

    if not update:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Status update not found"
        )

    update.active = False
    update.resolved_at = datetime.utcnow()

    db.commit()
    db.refresh(update)

    return update
