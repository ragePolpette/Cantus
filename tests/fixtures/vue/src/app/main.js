import { createApp } from "vue";
import OrderList from "../components/OrderList.vue";

const app = createApp({ template: "<order-list></order-list>" });
app.component("OrderList", OrderList);
app.mount("#app");
