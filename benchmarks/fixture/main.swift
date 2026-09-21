import UIKit

final class BenchController: UIViewController {
    var stack = UIStackView()
    var events: [String] = []
    var screen = "home"
    var fields: [UITextField] = []
    var values: [String: String] = [:]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24)
        ])
        render("home")
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        persist()
    }
    func persist() {
        let visibleLabels = stack.arrangedSubviews.compactMap { child -> String? in
            guard let label = child as? UILabel, !label.isHidden, label.alpha > 0,
                  label.window != nil, presentedViewController == nil else { return nil }
            let frame = label.convert(label.bounds, to: view)
            return frame.width > 0 && frame.height > 0 && view.bounds.contains(frame) ? label.text : nil
        }
        let data: [String: Any] = ["screen": screen, "events": events, "values": values, "visibleLabels": visibleLabels]
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("oracle.json")
        if let bytes = try? JSONSerialization.data(withJSONObject: data, options: .sortedKeys) { try? bytes.write(to: url, options: .atomic) }
    }
    func label(_ text: String, id: String) {
        let label = UILabel()
        label.text = text
        label.numberOfLines = 0
        label.font = .systemFont(ofSize: 22)
        label.accessibilityIdentifier = id
        stack.addArrangedSubview(label)
    }
    func button(_ text: String, id: String, action: @escaping () -> Void) {
        let button = UIButton(type: .system)
        button.setTitle(text, for: .normal)
        button.accessibilityIdentifier = id
        button.heightAnchor.constraint(equalToConstant: 48).isActive = true
        button.addAction(UIAction { [weak self] _ in self?.events.append(id); self?.persist(); action() }, for: .touchUpInside)
        stack.addArrangedSubview(button)
    }
    func field(_ name: String) {
        let field = UITextField()
        field.placeholder = name
        field.accessibilityLabel = name
        field.accessibilityIdentifier = "field-" + name.lowercased()
        field.borderStyle = .roundedRect
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.heightAnchor.constraint(equalToConstant: 44).isActive = true
        field.addAction(UIAction { [weak self, weak field] _ in
            self?.values[name] = field?.text ?? ""
            self?.persist()
        }, for: .editingChanged)
        fields.append(field)
        stack.addArrangedSubview(field)
    }
    func render(_ next: String) {
        view.endEditing(true)
        screen = next
        fields = []
        for child in stack.arrangedSubviews { stack.removeArrangedSubview(child); child.removeFromSuperview() }
        switch next {
        case "home":
            label("Jev Benchmark Home", id: "home-title")
            button("Browse products", id: "browse") { self.render("catalog") }
            button("Contact form", id: "contact") { self.render("form") }
            button("Delayed result", id: "delayed") { self.render("loading") }
        case "catalog":
            label("Product catalog", id: "catalog-title")
            button("Canvas backpack", id: "backpack") { self.render("details") }
            button("Travel mug", id: "mug") { self.render("wrong-product") }
        case "details":
            label("Canvas backpack details", id: "details-title")
            label("Price: 49 credits", id: "price")
            label("In stock", id: "availability")
        case "form":
            label("Contact details", id: "form-title")
            field("Name")
            field("Email")
            button("Save contact", id: "save") {
                self.values["Name"] = self.fields[0].text ?? ""
                self.values["Email"] = self.fields[1].text ?? ""
                self.render(self.values["Name"] == "Ada" && self.values["Email"] == "ada@example.com" ? "saved" : "invalid")
            }
        case "saved": label("Contact saved: Ada, ada@example.com", id: "saved-title")
        case "loading":
            label("Loading result…", id: "loading-title")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard self?.screen == "loading" else { return }
                self?.render("ready")
            }
        case "ready":
            label("Result ready", id: "ready-title")
            button("View result", id: "view-result") { self.render("result") }
        case "result": label("Reference: BENCH-204", id: "result-title")
        case "invalid": label("Invalid contact details", id: "invalid-title")
        default: label("Travel mug details", id: "wrong-title")
        }
        if next != "home" && next != "loading" {
            button("Back to home", id: "home") { self.render("home") }
        }
        persist()
    }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = BenchController()
        window?.makeKeyAndVisible()
        return true
    }
}
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
