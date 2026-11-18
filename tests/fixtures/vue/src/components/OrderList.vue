<template>
  <div class="orders">
    <price-tag v-for="o in orders" :key="o.id" :value="o.total"></price-tag>
    <Modal v-if="open" />
    <table><tr><td>{{ count }}</td></tr></table>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { formatTotal } from "../app/format";

/** Orders shown in the list. */
const orders = ref([]);
const count = formatTotal(orders.value.length);
</script>

<style scoped>
.orders { color: red; }
</style>
