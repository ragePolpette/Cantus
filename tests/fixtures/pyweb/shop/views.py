from django.http import JsonResponse
from django.views import View


def product_detail(request, pk):
    return JsonResponse({"id": pk})


class CartView(View):
    def get(self, request):
        return JsonResponse({"items": []})


def search(request, term):
    return JsonResponse({"term": term})
