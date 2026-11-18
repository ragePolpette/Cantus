from fastapi import APIRouter

router = APIRouter(prefix="/users")


@router.get("/{user_id}")
async def read_user(user_id: int):
    return {"id": user_id}


@router.post("/")
async def create_user():
    return {"created": True}
