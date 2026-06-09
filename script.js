async function buyData() {

    let phone = document.getElementById("phone").value;
    let network = document.getElementById("network").value;
    let bundle = document.getElementById("bundle").value;

    if (!phone || !network || !bundle) {
        alert("Please fill all fields");
        return;
    }

    try {
        const res = await fetch("/pay", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                phone,
                network,
                bundle
            })
        });

        const data = await res.json();

        alert(data.message);

    } catch (err) {
        console.log("Frontend Error:", err);
        alert("Request failed. Check server.");
    }
}
