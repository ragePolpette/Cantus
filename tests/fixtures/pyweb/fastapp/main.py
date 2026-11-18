from fastapi import FastAPI

from . import users

app = FastAPI()
app.include_router(users.router, prefix="/v1")


@app.get("/ping")
async def ping():
    return {"ok": True}
