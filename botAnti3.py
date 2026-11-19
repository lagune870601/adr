from mitmproxy import http
from mitmproxy.connection import Server
from mitmproxy.net.server_spec import ServerSpec
from mitmproxy import ctx
import random
import requests
import string

class ModifyHttpsHeaders:
    ip = None
    userAgent = None

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        print("request url", flow.request.url);
        if "replaceproxy.html" in flow.request.url:
            if "ip=" in flow.request.url:
                urlList = flow.request.url.split("ip=")
                self.ip = urlList[1]
            else:
                self.ip = self.getIspIp()
            print("update ip", self.ip)
        if self.ip is None:
            self.ip = self.getIspIp()
        if self.ip is not None:
            flow.request.headers["X-Forwarded-For"] = self.ip
            flow.request.headers["x-forwarded-for"] = self.ip
            flow.request.headers["X-Real-IP"] = self.ip
            flow.request.headers["x-real-ip"] = self.ip
            flow.request.headers["CF-Connecting-IP"] = self.ip
            flow.request.headers["cf-connecting-ip"] = self.ip
        self.delSomeHeaders(flow)
        print("request heads:", flow.request.headers)
        #if "ping0.cc" in flow.request.url:
        #    proxyInfo = self.get911Proxy()
        #    flow.server_conn = Server(address=flow.server_conn.address)
        #    flow.server_conn.via = ServerSpec(("http", (proxyInfo["ip"], int(proxyInfo["port"]))))

    def request(self, flow: http.HTTPFlow) -> None:
        flow.request.headers["X-Forwarded-For"] = self.ip
        flow.request.headers["x-forwarded-for"] = self.ip
        flow.request.headers["X-Real-IP"] = self.ip
        flow.request.headers["x-real-ip"] = self.ip
        if flow.request.url == "https://x.com/":
            print("in x..................")
            flow.response = http.Response.make(
                200,  # HTTP status code
                b"<!DOCTYPE html><html><head><title>Empty Page</title></head><body></body></html>",  # 标准的空 HTML 页面
                {"Content-Type": "text/html"}  # 响应头
            )
            return
        if flow.request.url.startswith("https://x.com/replaceproxy.html?ip="):
            print("Handling replaceproxy.html request...")
            flow.response = http.Response.make(
                200,  # HTTP status code
                b"<!DOCTYPE html><html><head><title>Empty Page</title></head><body></body></html>",  # 标准的空 HTML 页面
                {"Content-Type": "text/html"}  # 响应头
            )
            return
        if flow.request.url == "https://google.com/":
            print("in x..................")
            flow.response = http.Response.make(
                200,  # HTTP status code
                b"<!DOCTYPE html><html><head><title>Empty Page</title></head><body></body></html>",  # 标准的空 HTML 页面
                {"Content-Type": "text/html"}  # 响应头
            )
            return
        if flow.request.url.startswith("http://httpbin.org/replaceproxy.html?ip="):
            print("Handling replaceproxy.html request...")
            flow.response = http.Response.make(
                200,  # HTTP status code
                b"<!DOCTYPE html><html><head><title>Empty Page</title></head><body></body></html>",  # 标准的空 HTML 页面
                {"Content-Type": "text/html"}  # 响应头
            )
            return
    def getProxyFromCookie(self, headers):
        cookies = headers["cookie"]
        print("cookie", cookies)
        cookies = cookies.split(",")
        for cookie in cookies:
            if "proxy" in cookie:
                proxy = cookie.split("=")[1]
                if ":" in proxy:
                    proxy = proxy.split(":")
                    return {
                        "ip": proxy[0],
                        "port": proxy[1]
                    }
        return None

    def get911Proxy(self):
        proxyCountryList = ["US","CA","RU","GE", "DE", "IT","SG","KR","JP","AU","FR",""]
        country = proxyCountryList[random.randint(0, len(proxyCountryList) - 1)]
        proxyResult = requests.get(url="https://api.911proxy.com/web_v1/ip/get-ip-v3?app_key=d918e63eef4c2ce178d2ae343aa4b9d6&pt=9&num=1&ep=&cc=" + country + "&state=&city=&life=10&protocol=1&format=json&lb=\r\n")
        if proxyResult is not None:
            proxyResult = proxyResult.json()
            if "data" in proxyResult:
                proxyResult = proxyResult["data"]
                if "list" in proxyResult:
                    proxyResult = proxyResult["list"]
                    if proxyResult is not None and len(proxyResult) > 0:
                        proxyResult = proxyResult[0]
                        if ":" in proxyResult:
                            proxyResult = proxyResult.split(":")
                            return {
                                "ip": proxyResult[0],
                                "port": int(proxyResult[1])
                            }
        return None

    def get911Ip(self):
        proxyInfo = self.get911Proxy()
        proxies = {
            'http': 'http://' + proxyInfo['ip'] + ':' + str(proxyInfo['port'])
        }
        response = requests.get('http://httpbin.org/ip', proxies=proxies)
        response = response.json()
        ip = response["origin"]
        print("911proxy ip:" + ip);
        ipStrList = ip.split(".")
        newIp = ipStrList[0] + "." + ipStrList[1] + "." + ipStrList[2] + "." + str(random.randint(1,200))
        print("new ip:" + newIp);
        return newIp
        #return ip

    def getIspIp(self):
        while True:
            # ip = self.get911Ip()
            ip = str(random.randint(1,200)) + "." + str(random.randint(1,200)) + "." + str(random.randint(1,200)) + "." + str(random.randint(1,200))
            ipApi = "http://ip-api.com/json/" + ip
            ipResult = requests.get(url=ipApi, params={'fields': 'hosting'})
            print("ipResult", ipResult)
            ipResult = ipResult.json()
            if "hosting" in ipResult and not ipResult["hosting"]:
                return ip
            else:
                print("ip is datacenter ip, create a new one...")

    def delSomeHeaders(self, flow):
        if "sec-ch-ua-platform" in flow.request.headers:
            del flow.request.headers["sec-ch-ua-platform"]
        if "Sec-Ch-Ua-Platform" in flow.request.headers:
            del flow.request.headers["Sec-Ch-Ua-Platform"]
        if "sec-ch-ua-mobile" in flow.request.headers:
            del flow.request.headers["sec-ch-ua-mobile"]
        if "Sec-Ch-Ua-Mobile" in flow.request.headers:
            del flow.request.headers["Sec-Ch-Ua-Mobile"]
        if "sec-ch-ua" in flow.request.headers:
            del flow.request.headers["sec-ch-ua"]
        if "Sec-Ch-Ua" in flow.request.headers:
            del flow.request.headers["Sec-Ch-Ua"]

    def getUserAgent(self):
        ueList = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
            "Mozilla/5.0 (Windows NT 6.2; Win64; x64) AppleWebKit/536.3 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/536.3",
            "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/536.3 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/536.3",
            "Mozilla/5.0 (Windows NT 6.0; Win64; x64) AppleWebKit/536.3 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/536.3",
            "Mozilla/5.0 (Windows NT 6.2; Win64; x64) AppleWebKit/536.3 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/536.3",
            "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/536.3 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/536.3",
            "Mozilla/5.0 (Windows NT 6.0; Win64; x64) AppleWebKit/536.3 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/536.3",
            "Mozilla/5.0 (Windows NT 6.2; Win64; x64) AppleWebKit/536.3 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/536.3",
            "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/536.3 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/536.3",
            "Mozilla/5.0 (Windows NT 6.0; Win64; x64) AppleWebKit/536.3 (KHTML, like Gecko) Chrome/{chromeVersion} Safari/536.3",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:{rvVersion}) Gecko/20100101 Firefox/{firefoxVersion}",
            "Mozilla/5.0 (Windows NT 6.0; Win64; x64; rv:{rvVersion}) Gecko/20100101 Firefox/{firefoxVersion}",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.6; rv,{rvVersion}) Gecko/20100101 Firefox/{firefoxVersion}",
        ]
        androidVersionList = ["10", "11", "12", "13", "14"]
        iosVersionList = ["14", "15", "16", "17"]
        mobileBrandList = ["V2208A Build/TP1A.220624.014; wv", "ALN-AL00 Build/HUAWEIALN-AL00; wv", "ALT-AL10 Build/HUAWEIALT-AL10; wv", "M2011K2C Build/TKQ1.220829.002; wv",
            "SM-S9110 Build/UP1A.231005.007; wv", "V1965A Build/QP1A.190711.020; wv", "23116PN5BC Build/UKQ1.230804.001; wv", "NOP-AN00 Build/HUAWEINOP-AN01P; wv", "2211133C Build/UKQ1.230804.001; wv",
            "ALN-AL00 Build/HUAWEIALN-AL00; wv", "ALA-AN70 Build/HONORALA-AN70; wv", "Redmi K30 5G Build/SKQ1.211006.001; wv", "ALN-AL10 Build/HUAWEIALN-AL10; wv", "ALN-AL00 Build/HUAWEIALN-AL00; wv"]
        browserInfoList = ["XWEB/1260093 MMWEBSDK/20231202 MMWEBID/8933 MicroMessenger/8.0.47.2560(0x28002F51) WeChat/arm64 Weixin", "XWEB/1260093 MMWEBSDK/20240501 MMWEBID/4415 MicroMessenger/8.0.50.2701(0x28003255) WeChat/arm64 Weixin",
            "XWEB/1220067 MMWEBSDK/20240404 MMWEBID/8875 MicroMessenger/8.0.49.2600(0x280031D8) WeChat/arm64 Weixin", "XWEB/1260097 MMWEBSDK/20240301 MMWEBID/8938 MicroMessenger/8.0.48.2580(0x28003052) WeChat/arm64 Weixin",
            "XWEB/1260053 MMWEBSDK/20240501 MMWEBID/8100 MicroMessenger/8.0.50.2701(0x2800323E) WeChat/arm64 Weixin","XWEB/1220099 MMWEBSDK/20240404 MMWEBID/357 MicroMessenger/8.0.49.2600(0x2800315A) WeChat/arm64 Weixi",
            "MMWEBID/7727 MicroMessenger/8.0.49.2600(0x28003157) WeChat/arm64 Weixin", "XWEB/1260097 MMWEBSDK/20240501 MMWEBID/9352 MicroMessenger/8.0.50.2701(0x28003258) WeChat/arm64 Weixin",
            "XWEB/1220053 MMWEBSDK/20240404 MMWEBID/4020 MicroMessenger/8.0.49.2600(0x2800313F) WeChat/arm64 Weixin", "T7/13.64 BDOS/1.0 (HarmonyOS 3.0.0) SP-engine/3.5.0 baiduboxapp/13.64.0.10 (Baidu; P1 12) NABar/1.0",
            "T7/13.64 BDOS/1.0 (HarmonyOS 3.0.0) SP-engine/3.5.0 baiduboxapp/13.64.0.10 (Baidu; P1 12) NABar/1.0","uni-app Html5Plus/1.0 (Immersed/33.666668", ""]
        chromeVersion  = str(random.randint(10,135)) + ".0." + str(random.randint(1000,9999)) + "." + str(random.randint(10,999));
        firefoxVersion = str(random.randint(50,140)) + ".0"
        rvVersion = str(random.randint(10, 130)) + ".0"
        netTypeVersionList = ["4G", "5G", "WIFI"]
        ue = ueList[random.randint(0, len(ueList) - 1)]
        ue = ue.replace("{iosVersion}", iosVersionList[random.randint(0, len(iosVersionList) - 1)] + "_" + str(random.randint(1, 9)))
        ue = ue.replace("{mobileBrand}", mobileBrandList[random.randint(0, len(mobileBrandList) - 1)])
        ue = ue.replace("{browserInfo}", browserInfoList[random.randint(0, len(browserInfoList) - 1)])
        ue = ue.replace("{chromeVersion}", chromeVersion)
        ue = ue.replace("{firefoxVersion}", firefoxVersion)
        ue = ue.replace("{rvVersion}", rvVersion)
        ue = ue.replace("{netTypeVersion}", netTypeVersionList[random.randint(0, len(netTypeVersionList) - 1)])
        return ue

    def getReferer(self):
        refererTemplateList = ["https://www.youtube.com/watch?v={random}", "https://www.google.com/search?q={searchWordRandom}",
        "https://www.quora.com/{searchWordRandom}", "https://mail.google.com/mail/u/0/#inbox/{random}", "https://outlook.live.com/mail/0/inbox/id/{random}",
        "https://x.com/explore"]
        point = random.randint(0, 100)
        referer = None
        if point < 80:
            referer = refererTemplateList[random.randint(0, len(refererTemplateList) - 1)]
            referer = referer.replace("{random}", self.generateRandomString(10))
            referer = referer.replace("{searchWordRandom}", self.generateRandomString(5).upper() + "+" + self.generateRandomString(5).upper() + "+" + self.generateRandomString(5).upper())
        if point >= 80 and point <90:
            referer = "https://www." + self.generateRandomString(8) + ".com"
        return referer

    def generateRandomString(self, length):
        characters = string.ascii_lowercase + string.digits
        random_string = ''.join(
            random.choice(characters) for _ in range(length))
        return random_string
# 将这个addon添加到mitmproxy中
addons = [
    ModifyHttpsHeaders()
]