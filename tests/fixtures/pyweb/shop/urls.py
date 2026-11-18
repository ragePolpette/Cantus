from django.urls import path, re_path

from . import views

urlpatterns = [
    path("products/<int:pk>/", views.product_detail, name="product"),
    path("cart/", views.CartView.as_view(), name="cart"),
    re_path(r"^search/(?P<term>\w+)/$", views.search),
]
