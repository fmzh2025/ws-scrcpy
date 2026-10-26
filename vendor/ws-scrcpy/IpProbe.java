import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;

public final class IpProbe {
    private IpProbe() {}

    public static void main(String[] args) throws Exception {
        String target = args.length > 0 ? args[0] : "https://ipwho.is/";
        Proxy proxy = args.length > 1 ? parseProxy(args[1]) : Proxy.NO_PROXY;
        HttpURLConnection connection = (HttpURLConnection) new URL(target).openConnection(proxy);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(10000);
        connection.setInstanceFollowRedirects(true);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-cache");
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        StringBuilder body = new StringBuilder();
        if (stream != null) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"));
            String line;
            while ((line = reader.readLine()) != null) {
                body.append(line);
            }
            reader.close();
        }
        System.out.println(status + "\t" + body);
        connection.disconnect();
    }

    private static Proxy parseProxy(String value) {
        int separator = value.lastIndexOf(':');
        if (separator <= 0 || separator == value.length() - 1) {
            throw new IllegalArgumentException("Invalid proxy: " + value);
        }
        String host = value.substring(0, separator);
        int port = Integer.parseInt(value.substring(separator + 1));
        if (port < 1 || port > 65535) {
            throw new IllegalArgumentException("Invalid proxy port: " + port);
        }
        return new Proxy(Proxy.Type.HTTP, new InetSocketAddress(host, port));
    }
}
