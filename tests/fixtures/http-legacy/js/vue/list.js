new Vue({
  el: "#list",
  methods: {
    load: function () {
      this.$http.get("/api/items");
      this.$axios.delete("/api/items/" + this.id);
    },
  },
});
