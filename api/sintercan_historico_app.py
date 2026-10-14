"""Entrada alternativa da API Sintercan com histórico TOS.U_HIST.
Uso: uvicorn sintercan_historico_app:app --host 0.0.0.0 --port 8000
"""
import main
from historico_sintercan_api import router as historico_router

app = main.app
_old_route_count = len(app.router.routes)
app.include_router(historico_router)
# Novos PATCHs protegidos atendem antes dos legados; outros endpoints preservados.
_new_routes = app.router.routes[_old_route_count:]
_old_routes = app.router.routes[:_old_route_count]
app.router.routes[:] = _new_routes + _old_routes
